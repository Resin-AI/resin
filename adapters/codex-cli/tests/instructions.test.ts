import { describe, expect, it } from "vitest";
import { CODEX_RESIN_GUIDANCE } from "../src/instructions.js";

describe("CODEX_RESIN_GUIDANCE", () => {
  it("gives Code Mode an exec snippet that searches Resin's learned tools", async () => {
    const snippet = /do it in that `exec` call: `([^`]+)`/.exec(CODEX_RESIN_GUIDANCE)?.[1];
    expect(snippet).toBeDefined();
    const printed: string[] = [];
    const queries: unknown[] = [];
    const tools = {
      mcp__resin__search_tools: async (args: unknown) => {
        queries.push(args);
        return { content: [{ type: "text", text: "backup_orders_db" }] };
      },
    };
    // Code Mode runs an `exec` cell as an async body with `tools` and `text` in scope.
    await new Function("tools", "text", `return (async () => { ${snippet} })();`)(
      tools,
      (value: string) => printed.push(value),
    );
    expect(queries).toEqual([{ query: "<the command line>" }]);
    expect(printed).toEqual([
      JSON.stringify({ content: [{ type: "text", text: "backup_orders_db" }] }),
    ]);
  });
});
