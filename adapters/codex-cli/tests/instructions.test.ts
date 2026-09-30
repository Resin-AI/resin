import { describe, expect, it } from "vitest";
import { CODEX_RESIN_GUIDANCE } from "../src/instructions.js";

describe("CODEX_RESIN_GUIDANCE", () => {
  it("routes direct tool calling, where MCP tools are deferred, through tool_search", () => {
    expect(CODEX_RESIN_GUIDANCE).toMatch(/Without `exec`, they are deferred: call `tool_search`/);
  });

  it("gives Code Mode an exec snippet that prints only each learned tool's own description", () => {
    const snippet = /print them in that `exec` call: `([^`]+)`/.exec(CODEX_RESIN_GUIDANCE)?.[1];
    expect(snippet).toBeDefined();
    const printed: string[] = [];
    // Code Mode nests each tool's description between the server's instructions and its declaration.
    const instructions =
      "Learned tools rerun work recorded in this workspace.\nUse a tool only for the task.";
    const nested = (description: string) =>
      `${instructions}\n\n${description}\n\nexec tool declaration:\n\`\`\`ts\ndeclare const tools: { x(args: {}): Promise<unknown>; };\n\`\`\``;
    const ALL_TOOLS = [
      { name: "exec_command", description: "Run a command" },
      {
        name: "mcp__resin__backup_orders_db",
        description: nested("Backs up the orders database. Inputs: date."),
      },
      { name: "mcp__resin__rotate_logs", description: "Rotates the logs." },
      { name: "mcp__resin__search_tools", description: nested("Search") },
      { name: "mcp__resin__invoke_tool", description: nested("Invoke") },
      { name: "mcp__other__backup", description: "Other server" },
    ];
    new Function("ALL_TOOLS", "text", snippet!)(ALL_TOOLS, (value: string) => printed.push(value));
    expect(printed).toEqual([
      "mcp__resin__backup_orders_db: Backs up the orders database. Inputs: date.\n" +
        "mcp__resin__rotate_logs: Rotates the logs.",
    ]);
  });
});
