import { type HarnessInstallation, InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { SUPPORTED_HARNESS_IDS } from "../src/harness-registry.js";
import {
  HarnessConfigOrchestrator,
  type HarnessProbeOptions,
} from "../src/installer/harness-config.js";

async function everyHarnessPresent({
  harnessId,
  targetPath,
  customHome,
}: HarnessProbeOptions): Promise<HarnessInstallation> {
  return {
    harnessId,
    displayName: harnessId,
    version: "test",
    isInstalled: true,
    status: "ready",
    configPath: targetPath,
    homePath: customHome,
    detectedAt: "2026-08-28T12:00:00.000Z",
    metadata: {},
  };
}

describe("HarnessConfigOrchestrator", () => {
  it("configures every present harness in a clean environment", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const resinCommand = `${home}/.resin/bin/resin`;
    const workspace = "/home/developer/projects/my-project";

    const result = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
      probeHarness: everyHarnessPresent,
      gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
    });

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(SUPPORTED_HARNESS_IDS.length);
    expect(result.backups).toHaveLength(SUPPORTED_HARNESS_IDS.length);

    // Verify Claude config was written
    const claudeContent = await bridge.readFile(`${home}/.claude.json`);
    expect(claudeContent).not.toBeNull();
    const claudeJson = JSON.parse(claudeContent ?? "{}");
    expect(claudeJson.mcpServers.resin).toEqual({ command: resinCommand, args: ["mcp"] });

    // Verify Codex config was written
    const codexContent = await bridge.readFile(`${home}/.codex/config.toml`);
    expect(codexContent).not.toBeNull();
    expect(codexContent).toContain(`command = "${resinCommand}"`);
    expect(codexContent).toContain('args = ["mcp"]');

    // Verify OMP config was written
    const ompContent = await bridge.readFile(`${home}/.omp/agent/mcp.json`);
    expect(ompContent).not.toBeNull();
    const ompJson = JSON.parse(ompContent ?? "{}");
    expect(ompJson.mcpServers.resin).toEqual({ command: resinCommand, args: ["mcp"] });

    // Verify Muse Code settings were written with the schema version muse requires
    const museContent = await bridge.readFile(`${home}/.config/muse/settings.json`);
    expect(JSON.parse(museContent ?? "{}")).toEqual({
      schema_version: 1,
      mcp_servers: { resin: { command: resinCommand, args: ["mcp"] } },
    });
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
      probeHarness: everyHarnessPresent,
    });
    expect(firstRun.success).toBe(true);
    expect(firstRun.backups).toHaveLength(SUPPORTED_HARNESS_IDS.length);

    // Second run: should detect already configured state without applying new mutations
    const secondRun = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
      probeHarness: everyHarnessPresent,
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
      probeHarness: everyHarnessPresent,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.backups).toHaveLength(0);
    expect(result.results.every((r) => r.plan !== undefined)).toBe(true);

    // Nothing written to disk
    expect(await bridge.readFile(`${home}/.claude.json`)).toBeNull();
    expect(await bridge.readFile(`${home}/.codex/config.toml`)).toBeNull();
    expect(await bridge.readFile(`${home}/.omp/agent/mcp.json`)).toBeNull();
  });

  it("rolls back all applied configurations on failure", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const orchestrator = new HarnessConfigOrchestrator();

    const home = "/home/developer";
    const workspace = "/home/developer/projects/my-project";

    // Pre-populate original content
    await bridge.writeFile(`${home}/.claude.json`, '{"original": true}');
    await bridge.writeFile(`${home}/.codex/config.toml`, "# Original Codex Config\n");

    // Run first configuration
    const runResult = await orchestrator.configureHarnesses({
      customHome: home,
      workspacePath: workspace,
      fsBridge: bridge,
      probeHarness: everyHarnessPresent,
    });
    expect(runResult.success).toBe(true);

    // Trigger rollback
    await runResult.rollback();

    // Verify Claude was restored to original content
    const restoredClaude = await bridge.readFile(`${home}/.claude.json`);
    expect(restoredClaude).toBe('{"original": true}');

    // Verify Codex was restored to original content
    const restoredCodex = await bridge.readFile(`${home}/.codex/config.toml`);
    expect(restoredCodex).toBe("# Original Codex Config\n");
  });
});
