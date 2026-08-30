import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESIN_MCP_ARGS,
  CANONICAL_RESIN_MCP_COMMAND,
  CANONICAL_RESIN_MCP_SERVER_KEY,
  DEFAULT_RESIN_GATEWAY_URL,
  DEFAULT_RESIN_MCP_ARGS,
  DEFAULT_RESIN_MCP_COMMAND,
  InMemoryConfigFsBridge,
  LEGACY_RESIN_GATEWAY_URL,
  LEGACY_RESIN_MCP_SERVER_ALIASES,
  NodeConfigFsBridge,
  applyConfigMutation,
  computeConfigHash,
  isRecognizedResinMcpEntry,
  isResinMcpCommand,
  migrateJsonMcpServers,
  planConfigMutation,
  rollbackConfigMutation,
  verifyConfigIntegrity,
  verifyPreconditionHash,
} from "../src/config.js";
import { ConfigPreconditionFailedError } from "../src/errors.js";

describe("Configuration Mutation, Preconditions & Atomic Rollback", () => {
  it("computes config hash deterministically and verifies preconditions", () => {
    const content = '{"version": "1.0"}';
    const hash = computeConfigHash(content);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // Precondition match
    expect(verifyPreconditionHash(content, hash)).toBe(true);
    expect(verifyPreconditionHash(content, `sha256:${hash}`)).toBe(true);
    expect(verifyPreconditionHash(content, "wrong_hash")).toBe(false);

    // Precondition for non-existent file
    expect(verifyPreconditionHash(null, "")).toBe(true);
    expect(verifyPreconditionHash(null, "sha256:empty")).toBe(true);
    expect(verifyPreconditionHash(null, hash)).toBe(false);
  });

  it("plans configuration mutation with computed precondition hash", () => {
    const current = '{"old": true}';
    const planned = '{"old": true, "mcp": true}';
    const plan = planConfigMutation({
      harnessId: "omp",
      targetPath: "/etc/omp/config.json",
      currentContent: current,
      plannedContent: planned,
      description: "Inject MCP server",
    });

    expect(plan.harnessId).toBe("omp");
    expect(plan.targetPath).toBe("/etc/omp/config.json");
    expect(plan.preconditionHash).toBe(computeConfigHash(current));
    expect(plan.plannedContent).toBe(planned);
    expect(plan.backupPath).toBeDefined();
  });

  it("applies mutation and creates backup using InMemoryConfigFsBridge", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/workspaces/proj/.config.json";
    const initialContent = '{"initial": 1}';
    await fsBridge.writeFile(configPath, initialContent);

    const plan = planConfigMutation({
      harnessId: "claude-code",
      targetPath: configPath,
      currentContent: initialContent,
      plannedContent: '{"initial": 1, "mcp": 2}',
    });

    const backup = await applyConfigMutation(plan, fsBridge);
    expect(backup.targetPath).toBe(configPath);
    expect(backup.originalContent).toBe(initialContent);
    expect(backup.contentHash).toBe(computeConfigHash(initialContent));
    expect(backup.restored).toBe(false);

    // New content written
    expect(await fsBridge.readFile(configPath)).toBe('{"initial": 1, "mcp": 2}');

    // Backup content preserved
    expect(await fsBridge.readFile(backup.backupPath)).toBe(initialContent);

    // Rollback
    await rollbackConfigMutation(backup, fsBridge);
    expect(backup.restored).toBe(true);
    expect(await fsBridge.readFile(configPath)).toBe(initialContent);
  });

  it("handles rollback when original file did not exist", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const newConfigPath = "/workspaces/proj/new_config.json";

    const plan = planConfigMutation({
      harnessId: "codex-cli",
      targetPath: newConfigPath,
      currentContent: null,
      plannedContent: '{"created": true}',
    });

    const backup = await applyConfigMutation(plan, fsBridge);
    expect(backup.originalContent).toBe("");
    expect(await fsBridge.exists(newConfigPath)).toBe(true);

    // Rollback should delete the newly created file
    await rollbackConfigMutation(backup, fsBridge);
    expect(await fsBridge.exists(newConfigPath)).toBe(false);
  });

  it("throws ConfigPreconditionFailedError on hash mismatch / concurrent edit", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const configPath = "/app/config.json";
    await fsBridge.writeFile(configPath, '{"version": 1}');

    const plan = planConfigMutation({
      harnessId: "omp",
      targetPath: configPath,
      currentContent: '{"version": 1}',
      plannedContent: '{"version": 2}',
    });

    // Simulate concurrent modification before apply
    await fsBridge.writeFile(configPath, '{"version": 1, "concurrent_edit": true}');

    await expect(applyConfigMutation(plan, fsBridge)).rejects.toThrow(
      ConfigPreconditionFailedError,
    );
  });

  it("verifies config integrity correctly", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const filePath = "/etc/test.json";
    const content = '{"verified": true}';
    await fsBridge.writeFile(filePath, content);

    // Match exact content
    expect(await verifyConfigIntegrity(filePath, content, fsBridge)).toBe(true);

    // Match hash
    const hash = computeConfigHash(content);
    expect(await verifyConfigIntegrity(filePath, hash, fsBridge)).toBe(true);
    expect(await verifyConfigIntegrity(filePath, `sha256:${hash}`, fsBridge)).toBe(true);

    // Mismatch
    expect(await verifyConfigIntegrity(filePath, "wrong", fsBridge)).toBe(false);
    expect(await verifyConfigIntegrity("/nonexistent.json", content, fsBridge)).toBe(false);
  });

  it("performs atomic mutation and rollback with NodeConfigFsBridge on real disk", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-config-test-"));
    try {
      const nodeBridge = new NodeConfigFsBridge();
      const testFile = path.join(tempDir, "settings.json");
      const initialData = '{"port": 8080}';
      await nodeBridge.writeFile(testFile, initialData);

      const plan = planConfigMutation({
        harnessId: "disk-test",
        targetPath: testFile,
        currentContent: initialData,
        plannedContent: '{"port": 9090}',
      });

      const backup = await applyConfigMutation(plan, nodeBridge);
      expect(await nodeBridge.readFile(testFile)).toBe('{"port": 9090}');
      expect(await nodeBridge.readFile(backup.backupPath)).toBe(initialData);

      // Rollback
      await rollbackConfigMutation(backup, nodeBridge);
      expect(await nodeBridge.readFile(testFile)).toBe(initialData);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("Canonical MCP Server Naming and Safe Migration", () => {
    it("defines canonical resin key, stdio command, and legacy aliases", () => {
      expect(CANONICAL_RESIN_MCP_SERVER_KEY).toBe("resin");
      expect(CANONICAL_RESIN_MCP_COMMAND).toBe("resin");
      expect(DEFAULT_RESIN_MCP_COMMAND).toBe("resin");
      expect(CANONICAL_RESIN_MCP_ARGS).toEqual(["mcp"]);
      expect(DEFAULT_RESIN_MCP_ARGS).toEqual(["mcp"]);
      expect(LEGACY_RESIN_MCP_SERVER_ALIASES).toEqual(["resin_gateway", "resin-gateway"]);
      expect(DEFAULT_RESIN_GATEWAY_URL).toBe("http://127.0.0.1:9400/mcp/sse");
      expect(LEGACY_RESIN_GATEWAY_URL).toBe("http://127.0.0.1:9400/mcp/sse");
    });

    it("identifies resin-mcp commands correctly", () => {
      expect(isResinMcpCommand("resin-mcp")).toBe(true);
      expect(isResinMcpCommand("/usr/local/bin/resin-mcp")).toBe(true);
      expect(isResinMcpCommand("C:\\Users\\user\\.resin\\bin\\resin-mcp.exe")).toBe(true);
      expect(isResinMcpCommand("node /path/to/resin-mcp.mjs")).toBe(true);
      expect(isResinMcpCommand("custom-mcp-tool")).toBe(false);
      expect(isResinMcpCommand("")).toBe(false);
    });

    it("identifies recognized Resin-owned MCP entries by URL or command", () => {
      expect(isRecognizedResinMcpEntry({ url: "http://127.0.0.1:9400/mcp/sse" })).toBe(true);
      expect(isRecognizedResinMcpEntry({ endpoint: "http://127.0.0.1:9400/mcp/sse" })).toBe(true);
      expect(isRecognizedResinMcpEntry({ url: "http://localhost:9400/mcp/sse" })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "resin", args: ["mcp"] })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "/usr/bin/resin", args: ["mcp"] })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "resin-mcp" })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "/usr/bin/resin-mcp" })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "node", args: ["resin-mcp"] })).toBe(true);
      expect(isRecognizedResinMcpEntry({ command: "node", args: ["/path/to/resin", "mcp"] })).toBe(
        true,
      );
      expect(isRecognizedResinMcpEntry({ command: "resin" })).toBe(false);
      expect(isRecognizedResinMcpEntry({ command: "resin", args: [] })).toBe(false);
      expect(isRecognizedResinMcpEntry({ command: "resin", args: ["status"] })).toBe(false);
      expect(
        isRecognizedResinMcpEntry(
          { url: "http://custom-host:9999/mcp/sse" },
          "http://custom-host:9999/mcp/sse",
        ),
      ).toBe(true);
      expect(isRecognizedResinMcpEntry({ url: "http://other-service.internal" })).toBe(false);
      expect(isRecognizedResinMcpEntry({ command: "custom-tool" })).toBe(false);
      expect(isRecognizedResinMcpEntry(null)).toBe(false);
      expect(isRecognizedResinMcpEntry(undefined)).toBe(false);
    });

    it("migrates recognized legacy alias to canonical resin entry", () => {
      const initial = {
        resin_gateway: { url: "http://127.0.0.1:9400/mcp/sse" },
        other_server: { command: "other" },
      };
      const migrated = migrateJsonMcpServers(initial, {
        command: "resin",
        args: ["mcp"],
      });
      expect(migrated.resin_gateway).toBeUndefined();
      expect(migrated.resin).toEqual({ command: "resin", args: ["mcp"] });
      expect(migrated.other_server).toEqual({ command: "other" });
    });

    it("resolves coexistence by keeping canonical resin and removing owned legacy alias", () => {
      const initial = {
        resin: { command: "resin", args: ["mcp"] },
        "resin-gateway": { url: "http://127.0.0.1:9400/mcp/sse" },
      };
      const migrated = migrateJsonMcpServers(initial, {
        command: "resin",
        args: ["mcp"],
      });
      expect(migrated["resin-gateway"]).toBeUndefined();
      expect(migrated.resin).toEqual({ command: "resin", args: ["mcp"] });
    });

    it("preserves unrecognized same-named legacy alias when not Resin-owned", () => {
      const initial = {
        resin_gateway: { url: "http://user-internal-tools.corp/sse" },
        "resin-gateway": { command: "my-custom-gateway" },
      };
      const migrated = migrateJsonMcpServers(initial, {
        command: "resin",
        args: ["mcp"],
      });
      expect(migrated.resin_gateway).toEqual({ url: "http://user-internal-tools.corp/sse" });
      expect(migrated["resin-gateway"]).toEqual({ command: "my-custom-gateway" });
      expect(migrated.resin).toEqual({ command: "resin", args: ["mcp"] });
    });
  });
});
