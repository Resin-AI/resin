import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { HarnessConfigOrchestrator } from "../src/installer/harness-config.js";

describe("HarnessConfigOrchestrator", () => {
  it("configures Claude Code, Codex CLI, and OMP in a clean environment", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const workspace = "/home/developer/projects/my-project";

    const result = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
      gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.backups).toHaveLength(3);

    // Verify Claude config was written
    const claudeContent = await bridge.readFile(`${home}/.claude/claude.json`);
    expect(claudeContent).not.toBeNull();
    const claudeJson = JSON.parse(claudeContent ?? "{}");
    expect(claudeJson.mcpServers.resin.url).toBe("http://127.0.0.1:9400/mcp/sse");

    // Verify Codex config was written
    const codexContent = await bridge.readFile(`${home}/.codex/config.toml`);
    expect(codexContent).not.toBeNull();
    expect(codexContent).toContain("resin-mcp");

    // Verify OMP config was written
    const ompContent = await bridge.readFile(`${home}/.omp/agent/mcp.json`);
    expect(ompContent).not.toBeNull();
    const ompJson = JSON.parse(ompContent ?? "{}");
    expect(ompJson.mcpServers.resin).toEqual({ command: "resin-mcp", args: [] });
  });

  it("is idempotent when re-run on already configured harnesses", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const workspace = "/home/developer/projects/my-project";

    // First run: apply configurations
    const firstRun = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
    });
    expect(firstRun.success).toBe(true);
    expect(firstRun.backups).toHaveLength(3);

    // Second run: should detect already configured state without applying new mutations
    const secondRun = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
    });

    expect(secondRun.success).toBe(true);
    expect(secondRun.backups).toHaveLength(0);
    expect(secondRun.results.every((r) => r.wasAlreadyConfigured)).toBe(true);
  });

  it("simulates mutations without writing to disk during dryRun", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const workspace = "/home/developer/projects/my-project";

    const result = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.backups).toHaveLength(0);
    expect(result.results.every((r) => r.plan !== undefined)).toBe(true);

    // Nothing written to disk
    expect(await bridge.readFile(`${home}/.claude/claude.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBeNull();
    expect(await bridge.readFile(`${home}/.omp/agent/mcp.json`)).toBeNull();
  });

  it("rolls back all applied configurations on failure", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const workspace = "/home/developer/projects/my-project";

    // Pre-populate original content
    await bridge.writeFile(`${home}/.claude/claude.json`, '{"original": true}');
    await bridge.writeFile(`${home}/.codex/config.toml`, "# Original Codex Config\n");

    // Run first configuration
    const runResult = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
    });
    expect(runResult.success).toBe(true);

    // Trigger rollback
    await runResult.rollback();

    // Verify Claude was restored to original content
    const restoredClaude = await bridge.readFile(`${home}/.claude/claude.json`);
    expect(restoredClaude).toBe('{"original": true}');

    // Verify Codex was restored to original content
    const restoredCodex = await bridge.readFile(`${home}/.codex/config.toml`);
    expect(restoredCodex).toBe("# Original Codex Config\n");
  });
});
