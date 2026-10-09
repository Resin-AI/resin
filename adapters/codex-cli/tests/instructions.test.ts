import { describe, expect, it } from "vitest";
import { CODEX_RESIN_GUIDANCE } from "../src/instructions.js";

describe("CODEX_RESIN_GUIDANCE", () => {
  it("gives Code Mode an exec snippet that runs a Resin learned tool", async () => {
    const snippet = /`(text\([^`]+)`/.exec(CODEX_RESIN_GUIDANCE)?.[1];
    expect(snippet).toBeDefined();
    const printed: string[] = [];
    const calls: unknown[] = [];
    const tools = {
      mcp__resin__invoke_tool: async (args: unknown) => {
        calls.push(args);
        return { content: [{ type: "text", text: "backed up" }] };
      },
    };
    // Code Mode runs an `exec` cell as an async body with `tools` and `text` in scope.
    await new Function("tools", "text", `return (async () => { ${snippet} })();`)(
      tools,
      (value: string) => printed.push(value),
    );
    expect(calls).toEqual([{ name: "<name>", parameters: {} }]);
    expect(printed).toEqual([JSON.stringify({ content: [{ type: "text", text: "backed up" }] })]);
  });
});
