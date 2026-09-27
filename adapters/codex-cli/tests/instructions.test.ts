import { describe, expect, it } from "vitest";
import { CODEX_RESIN_GUIDANCE } from "../src/instructions.js";

describe("CODEX_RESIN_GUIDANCE", () => {
  it("routes direct tool calling, where MCP tools are deferred, through tool_search", () => {
    expect(CODEX_RESIN_GUIDANCE).toMatch(/Without `exec`, they are deferred: call `tool_search`/);
  });

  it("gives Code Mode an exec snippet that prints only the learned tools", () => {
    const snippet = /print them in that `exec` call: `([^`]+)`/.exec(CODEX_RESIN_GUIDANCE)?.[1];
    expect(snippet).toBeDefined();
    const printed: string[] = [];
    const ALL_TOOLS = [
      { name: "exec_command", description: "Run a command" },
      { name: "mcp__resin__backup_orders_db", description: "Runs dbtool backup {date}" },
      { name: "mcp__resin__search_tools", description: "Search" },
      { name: "mcp__resin__invoke_tool", description: "Invoke" },
      { name: "mcp__other__backup", description: "Other server" },
    ];
    new Function("ALL_TOOLS", "text", snippet!)(ALL_TOOLS, (value: string) => printed.push(value));
    expect(printed).toEqual(["mcp__resin__backup_orders_db\nRuns dbtool backup {date}"]);
  });
});
