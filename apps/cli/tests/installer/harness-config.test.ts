import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  HarnessConfigOrchestrator,
  RESIN_MCP_SERVER_KEYS,
  planHarnessRegistration,
  resolveHarnessConfigPath,
  resolveInstalledResinMcpCommand,
  verifyHarnessRegistration,
} from "../../src/installer/harness-config.js";

class OneRollbackFailureBridge implements ConfigFsBridge {
  private failRollback = true;

  constructor(
    private readonly delegate: ConfigFsBridge,
    private readonly targetPath: string,
    private readonly originalContent: string,
  ) {}

  readFile(filePath: string): Promise<string | null> {
    return this.delegate.readFile(filePath);
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (filePath === this.targetPath && content === this.originalContent && this.failRollback) {
      this.failRollback = false;
      throw new Error("simulated rollback write failure");
    }
    await this.delegate.writeFile(filePath, content);
  }

  exists(filePath: string): Promise<boolean> {
    return this.delegate.exists(filePath);
  }

  mkdirp(directoryPath: string): Promise<void> {
    return this.delegate.mkdirp(directoryPath);
  }

  copyFile(sourcePath: string, destinationPath: string): Promise<void> {
    return this.delegate.copyFile(sourcePath, destinationPath);
  }

  unlink(filePath: string): Promise<void> {
    return this.delegate.unlink(filePath);
  }
}

describe("harness adapter operations", () => {
  it("resolves default and environment-specific global config paths", () => {
    const home = "/home/developer";

    expect(resolveHarnessConfigPath("claude-code", home)).toBe("/home/developer/.claude.json");
    expect(resolveHarnessConfigPath("codex-cli", home)).toBe("/home/developer/.codex/config.toml");
    expect(resolveHarnessConfigPath("omp", home)).toBe("/home/developer/.omp/agent/mcp.json");
    expect(resolveInstalledResinMcpCommand(home)).toBe("/home/developer/.resin/bin/resin");

    expect(
      resolveHarnessConfigPath("claude-code", home, {
        CLAUDE_CONFIG_DIR: "/profiles/claude",
      }),
    ).toBe("/profiles/claude/.claude.json");
    expect(
      resolveHarnessConfigPath("codex-cli", home, {
        CODEX_HOME: "/profiles/codex",
      }),
    ).toBe("/profiles/codex/config.toml");
    expect(
      resolveHarnessConfigPath("codex-cli", home, {
        CODEX_HOME: "/profiles/codex",
        CODEX_CONFIG_PATH: "/profiles/codex/custom.json",
      }),
    ).toBe("/profiles/codex/custom.json");
    expect(resolveHarnessConfigPath("omp", home, { OMP_HOME: "/profiles/omp" })).toBe(
      "/profiles/omp/agent/mcp.json",
    );
    expect(resolveHarnessConfigPath("omp", home, { RESIN_OMP_HOME: "/profiles/resin-omp" })).toBe(
      "/profiles/resin-omp/agent/mcp.json",
    );
    expect(
      resolveHarnessConfigPath("omp", home, {
        OMP_HOME: "",
        RESIN_OMP_HOME: "/profiles/resin-omp",
      }),
    ).toBe("/profiles/resin-omp/agent/mcp.json");
    expect(RESIN_MCP_SERVER_KEYS).toEqual({
      "claude-code": "resin",
      "codex-cli": "resin",
      omp: "resin",
    });
  });

  it("plans registrations without removing user JSON servers, settings, or env", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";
    const cases = [
      {
        harnessId: "claude-code" as const,
        targetPath: "/home/developer/.claude.json",
        serverKey: "resin",
        expectedServer: { command: "resin", args: ["mcp"] },
      },
      {
        harnessId: "omp" as const,
        targetPath: "/home/developer/.omp/agent/mcp.json",
        serverKey: "resin",
        expectedServer: { command: "resin", args: ["mcp"] },
      },
    ];

    for (const testCase of cases) {
      const original = {
        settings: { theme: "dark", telemetry: false },
        env: { USER_TOKEN: "keep-me" },
        mcpServers: {
          user_server: {
            command: "user-mcp",
            env: { USER_SERVER_TOKEN: "also-keep-me" },
          },
        },
      };
      await bridge.writeFile(testCase.targetPath, JSON.stringify(original));

      const plan = await planHarnessRegistration({
        harnessId: testCase.harnessId,
        targetPath: testCase.targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl,
        fsBridge: bridge,
      });
      // SAFETY: Planned JSON content preserves original configuration structure.
      const planned = JSON.parse(plan.plannedContent) as typeof original;

      expect(planned.settings).toEqual(original.settings);
      expect(planned.env).toEqual(original.env);
      expect(planned.mcpServers.user_server).toEqual(original.mcpServers.user_server);
      expect(planned.mcpServers[testCase.serverKey]).toMatchObject(testCase.expectedServer);
    }
  });

  it("preserves unrelated Codex TOML sections and verifies the Resin section in scope", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = "/home/developer/.codex/config.toml";
    const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";
    const original = [
      'model = "gpt-5.6"',
      "",
      "[mcp_servers.user_server]",
      'command = "user-mcp"',
      'env.USER_TOKEN = "keep-me"',
      "",
      "[mcp_servers.resin]",
      'url = "http://old.invalid/sse"',
      "",
    ].join("\n");
    await bridge.writeFile(targetPath, original);

    const plan = await planHarnessRegistration({
      harnessId: "codex-cli",
      targetPath,
      workspacePath: "/workspace/project",
      gatewayUrl,
      fsBridge: bridge,
    });

    expect(plan.plannedContent).toContain('model = "gpt-5.6"');
    expect(plan.plannedContent).toContain("[mcp_servers.user_server]");
    expect(plan.plannedContent).toContain('env.USER_TOKEN = "keep-me"');
    expect(plan.plannedContent).toContain("[mcp_servers.resin]");
    expect(plan.plannedContent).toContain('command = "resin"');
    expect(plan.plannedContent).toContain('args = ["mcp"]');

    await bridge.writeFile(
      targetPath,
      [
        "[mcp_servers.resin]",
        'url = "http://wrong.invalid/sse"',
        "",
        "[mcp_servers.user_server]",
        `url = "${gatewayUrl}"`,
      ].join("\n"),
    );
    expect(
      await verifyHarnessRegistration({
        harnessId: "codex-cli",
        targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl,
        fsBridge: bridge,
      }),
    ).toBe(false);
  });

  it("validates every Resin-owned transport field instead of URL alone", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const targetPath = "/home/developer/.claude.json";
    await bridge.writeFile(
      targetPath,
      JSON.stringify({
        mcpServers: {
          resin: {
            type: "stdio",
            command: "/missing/resin",
            args: ["--wrong"],
            url: "http://127.0.0.1:9400/mcp/sse",
          },
        },
      }),
    );
    await expect(
      verifyHarnessRegistration({
        harnessId: "claude-code",
        targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
        fsBridge: bridge,
      }),
    ).resolves.toBe(false);

    await bridge.writeFile(
      targetPath,
      JSON.stringify({
        mcpServers: {
          resin: {
            type: "http",
            command: "resin",
            args: ["mcp"],
          },
        },
      }),
    );
    await expect(
      verifyHarnessRegistration({
        harnessId: "claude-code",
        targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
        fsBridge: bridge,
      }),
    ).resolves.toBe(false);

    await bridge.writeFile(
      targetPath,
      JSON.stringify({
        mcpServers: {
          resin: {
            command: "resin",
            args: ["mcp"],
          },
        },
      }),
    );

    await expect(
      verifyHarnessRegistration({
        harnessId: "claude-code",
        targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
        fsBridge: bridge,
      }),
    ).resolves.toBe(true);
  });
  it("round-trips dotted, quoted, and inline Codex server forms without redefining tables", async () => {
    const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";
    const targetPath = "/home/developer/.codex/config.toml";
    const cases = [
      [
        'mcp_servers.resin = { type = "stdio", command = "/missing", url = "http://old", headers = { Authorization = "keep-inline" } }',
        "keep-inline",
      ],
      [
        '["mcp_servers"."resin"]',
        'url = "http://old"',
        'type = "stdio"',
        'env.RESIN_TOKEN = "keep-quoted"',
        "",
        "keep-quoted",
      ],
      [
        "[mcp_servers]",
        'resin = { url = "http://old", command = "/missing", headers = { X_User = "keep-container-inline" } }',
        "",
        "keep-container-inline",
      ],
    ] as const;

    for (const parts of cases) {
      const marker = parts.at(-1)!;
      const original = parts.slice(0, -1).join("\n");
      const bridge = new InMemoryConfigFsBridge();
      await bridge.writeFile(targetPath, original);
      const plan = await planHarnessRegistration({
        harnessId: "codex-cli",
        targetPath,
        workspacePath: "/workspace/project",
        gatewayUrl,
        fsBridge: bridge,
      });

      expect(plan.plannedContent).toContain(marker);
      expect(plan.plannedContent).not.toContain('command = "/missing"');
      expect(plan.plannedContent).not.toContain('type = "stdio"');
      await bridge.writeFile(targetPath, plan.plannedContent);
      await expect(
        verifyHarnessRegistration({
          harnessId: "codex-cli",
          targetPath,
          workspacePath: "/workspace/project",
          gatewayUrl,
          fsBridge: bridge,
        }),
      ).resolves.toBe(true);
    }
  });

  it("routes the legacy orchestrator through preservation and corrupt-config safeguards", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const claudePath = "/home/developer/.claude.json";
    await bridge.writeFile(
      claudePath,
      JSON.stringify({
        theme: "keep",
        mcpServers: {
          resin: {
            type: "stdio",
            command: "/old",
            url: "http://old",
            headers: { Authorization: "keep-resin-header" },
            env: { RESIN_TOKEN: "keep-resin-env" },
          },
        },
      }),
    );

    const result = await new HarnessConfigOrchestrator().configureHarnesses({
      harnesses: ["claude-code"],
      customHome: "/home/developer",
      workspacePath: "/workspace/project",
      gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
      fsBridge: bridge,
    });
    expect(result.success).toBe(true);
    const repaired = JSON.parse((await bridge.readFile(claudePath)) ?? "");
    expect(repaired.theme).toBe("keep");
    expect(repaired.mcpServers.resin).toMatchObject({
      command: "/home/developer/.resin/bin/resin",
      args: ["mcp"],
      headers: { Authorization: "keep-resin-header" },
      env: { RESIN_TOKEN: "keep-resin-env" },
    });
    expect(repaired.mcpServers.resin.url).toBeUndefined();
    const corrupt = '{"mcpServers":';
    await bridge.writeFile(claudePath, corrupt);
    const failed = await new HarnessConfigOrchestrator().configureHarnesses({
      harnesses: ["claude-code"],
      customHome: "/home/developer",
      fsBridge: bridge,
    });
    expect(failed.success).toBe(false);
    expect(await bridge.readFile(claudePath)).toBe(corrupt);
    expect(failed.backups).toHaveLength(0);
  });

  it("writes to the active Codex home supplied by the environment", async () => {
    const bridge = new InMemoryConfigFsBridge();
    const activePath = "/profiles/codex/config.toml";

    const result = await new HarnessConfigOrchestrator().configureHarnesses({
      harnesses: ["codex-cli"],
      customHome: "/home/developer",
      env: { HOME: "/home/developer", CODEX_HOME: "/profiles/codex" },
      fsBridge: bridge,
    });

    expect(result.success).toBe(true);
    expect(await bridge.readFile(activePath)).toContain("[mcp_servers.resin]");
    expect(await bridge.readFile(activePath)).toContain(
      'command = "/home/developer/.resin/bin/resin"',
    );
    expect(await bridge.readFile("/home/developer/.codex/config.toml")).toBeNull();
  });

  it("reports and retains a failed legacy rollback so the same closure can retry", async () => {
    const delegate = new InMemoryConfigFsBridge();
    const targetPath = "/home/developer/.claude.json";
    const original = JSON.stringify({
      mcpServers: { resin: { type: "sse", url: "http://old" } },
    });
    await delegate.writeFile(targetPath, original);
    await delegate.writeFile("/home/developer/.codex/config.toml", 'invalid = "unterminated');
    const bridge = new OneRollbackFailureBridge(delegate, targetPath, original);
    const result = await new HarnessConfigOrchestrator().configureHarnesses({
      harnesses: ["claude-code", "codex-cli"],
      customHome: "/home/developer",
      gatewayUrl: "http://127.0.0.1:9400/mcp/sse",
      fsBridge: bridge,
    });
    expect(result.success).toBe(false);
    expect(result.backups).toHaveLength(1);
    expect(result.rollbackErrors?.join("; ")).toContain("simulated rollback write failure");
    expect(result.error).toContain("Rollback failed");
    expect(await delegate.readFile(targetPath)).not.toBe(original);
    await expect(result.rollback()).resolves.toBeUndefined();
    expect(await delegate.readFile(targetPath)).toBe(original);
  });

  describe("legacy alias migration and coexistence across harnesses", () => {
    it("migrates recognized legacy aliases for Claude Code, Codex CLI, and OMP", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";

      // 1. Claude Code
      await bridge.writeFile(
        "/home/developer/.claude.json",
        JSON.stringify({
          mcpServers: {
            resin_gateway: { url: gatewayUrl },
            user_srv: { command: "user-tool" },
          },
        }),
      );
      const claudePlan = await planHarnessRegistration({
        harnessId: "claude-code",
        targetPath: "/home/developer/.claude.json",
        workspacePath: "/workspace",
        gatewayUrl,
        fsBridge: bridge,
      });
      const claudeParsed = JSON.parse(claudePlan.plannedContent);
      expect(claudeParsed.mcpServers.resin).toEqual({ command: "resin", args: ["mcp"] });
      expect(claudeParsed.mcpServers.resin_gateway).toBeUndefined();
      expect(claudeParsed.mcpServers.user_srv).toBeDefined();

      // 2. Codex CLI (TOML)
      await bridge.writeFile(
        "/home/developer/.codex/config.toml",
        [
          "[mcp_servers.resin_gateway]",
          `url = "${gatewayUrl}"`,
          "",
          "[mcp_servers.user_tool]",
          'command = "user-bin"',
        ].join("\n"),
      );
      const codexPlan = await planHarnessRegistration({
        harnessId: "codex-cli",
        targetPath: "/home/developer/.codex/config.toml",
        workspacePath: "/workspace",
        gatewayUrl,
        fsBridge: bridge,
      });
      expect(codexPlan.plannedContent).toContain("[mcp_servers.resin]");
      expect(codexPlan.plannedContent).toContain('command = "resin"');
      expect(codexPlan.plannedContent).toContain('args = ["mcp"]');
      expect(codexPlan.plannedContent).not.toContain("[mcp_servers.resin_gateway]");
      expect(codexPlan.plannedContent).toContain("[mcp_servers.user_tool]");

      // 3. OMP
      await bridge.writeFile(
        "/home/developer/.omp/agent/mcp.json",
        JSON.stringify({
          mcpServers: {
            "resin-gateway": { type: "sse", url: gatewayUrl },
            user_tool: { command: "user-bin" },
          },
        }),
      );
      const ompPlan = await planHarnessRegistration({
        harnessId: "omp",
        targetPath: "/home/developer/.omp/agent/mcp.json",
        workspacePath: "/workspace",
        gatewayUrl,
        fsBridge: bridge,
      });
      const ompParsed = JSON.parse(ompPlan.plannedContent);
      expect(ompParsed.mcpServers.resin).toEqual({ command: "resin", args: ["mcp"] });
      expect(ompParsed.mcpServers["resin-gateway"]).toBeUndefined();
      expect(ompParsed.mcpServers.user_tool).toBeDefined();
    });

    it("preserves unrecognized same-named entries when not Resin-owned", async () => {
      const bridge = new InMemoryConfigFsBridge();
      const gatewayUrl = "http://127.0.0.1:9400/mcp/sse";

      await bridge.writeFile(
        "/home/developer/.codex/config.toml",
        ["[mcp_servers.resin_gateway]", 'url = "http://internal.company.corp/sse"'].join("\n"),
      );
      const codexPlan = await planHarnessRegistration({
        harnessId: "codex-cli",
        targetPath: "/home/developer/.codex/config.toml",
        workspacePath: "/workspace",
        gatewayUrl,
        fsBridge: bridge,
      });
      expect(codexPlan.plannedContent).toContain("[mcp_servers.resin]");
      expect(codexPlan.plannedContent).toContain("[mcp_servers.resin_gateway]");
      expect(codexPlan.plannedContent).toContain('url = "http://internal.company.corp/sse"');
    });
  });
});
