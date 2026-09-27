import { describe, expect, it } from "vitest";
import { isHarnessIntrospectionProgram, referencesHarnessState } from "../src/index.js";

describe("isHarnessIntrospectionProgram", () => {
  it.each([
    // The recorded shell program behind the published `list_resin_tools` (production, 2026-09-27).
    `node -e 'const ALL_TOOLS=[]; console.log(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))'`,
    "resin status --json",
    "cd /work && RESIN_LOG=debug resin tools list | jq .",
    "true\nresin doctor",
    "timeout 5 /home/user/.resin/current/bin/resin-daemon --version",
    "sudo -u deploy resin status",
    "env -u DEBUG resin doctor",
    "timeout -s KILL 5 resin status",
    "bash -c 'resin status'",
    'sh -lc "codex mcp list"',
    "pnpm exec resin status",
    "bun x resin tools",
    "yarn resin status",
    "cat ~/.codex/config.toml",
    // Normalization aliases the home directory to `$HOME` before a program leaves the machine.
    "cat $HOME/.codex/config.toml",
    'jq .mcpServers "$HOME/.claude.json"',
    "ls ${HOME}/.omp/agent",
    'du -sh "$RESIN_HOME"',
    "type %USERPROFILE%\\.codex\\config.toml",
    "Get-Content $env:USERPROFILE\\.claude.json",
    "type C:\\Users\\alice\\.resin\\config.json",
    "codex mcp list",
    "codex -c model=o3 mcp list",
    "claude --model opus mcp get resin",
  ])("flags %s", (source) => {
    expect(isHarnessIntrospectionProgram(source)).toBe(true);
  });

  it.each([
    "./dbtool dump --date 2025-06-01 resin_orders",
    "grep -ri resin data/catalog.csv",
    'echo "resin" | tr a-z A-Z',
    "python3 scripts/price_resin.py --grade epoxy",
    "cat ./.codex-notes.md",
    "codex exec 'summarize resin suppliers'",
    "codex -m mcp exec 'summarize'",
    "npx resin build",
    "./node_modules/.bin/resin build",
    "./bin/resin --grade epoxy",
    "bash -c './dbtool dump resin_orders'",
  ])("keeps %s", (source) => {
    expect(isHarnessIntrospectionProgram(source)).toBe(false);
  });

  it("reads namespace and home-state signals in embedded programs, but no command positions", () => {
    expect(
      isHarnessIntrospectionProgram("print(open('/root/.codex/auth.json').read())", "python"),
    ).toBe(true);
    expect(isHarnessIntrospectionProgram("resin = load('resin.csv')", "python")).toBe(false);
  });

  it("finds harness state in output text, not the word resin", () => {
    expect(referencesHarnessState("mcp__resin__invoke_tool\nInvokes a tool")).toBe(true);
    expect(referencesHarnessState("resin_orders -> backups/resin_orders.sql")).toBe(false);
  });
});
