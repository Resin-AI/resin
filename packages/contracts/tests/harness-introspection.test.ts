import { describe, expect, it } from "vitest";
import { isHarnessIntrospectionProgram } from "../src/index.js";

describe("isHarnessIntrospectionProgram", () => {
  it.each([
    // The recorded shell program behind the published `list_resin_tools` (production, 2026-09-27).
    `node -e 'const ALL_TOOLS=[]; console.log(ALL_TOOLS.filter(t => t.name.startsWith("mcp__resin__") && !/__(search_tools|get_tool_schema|invoke_tool|manage_tools)$/.test(t.name)).map(t => t.name + "\\n" + t.description).join("\\n\\n"))'`,
    "resin status --json",
    "cd /work && RESIN_LOG=debug npx resin tools list | jq .",
    "timeout 5 /home/user/.resin/current/bin/resin-daemon --version",
    "cat ~/.codex/config.toml",
    'jq .mcpServers "$HOME/.claude.json"',
    "ls ${HOME}/.omp/agent",
    'du -sh "$RESIN_HOME"',
    "codex mcp list",
    "claude --debug mcp get resin",
    "true\nresin doctor",
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
  ])("keeps %s", (source) => {
    expect(isHarnessIntrospectionProgram(source)).toBe(false);
  });

  it("reads namespace and home-state signals in embedded programs, but no command positions", () => {
    expect(
      isHarnessIntrospectionProgram("print(open('/root/.codex/auth.json').read())", "python"),
    ).toBe(true);
    expect(isHarnessIntrospectionProgram("resin = load('resin.csv')", "python")).toBe(false);
  });
});
