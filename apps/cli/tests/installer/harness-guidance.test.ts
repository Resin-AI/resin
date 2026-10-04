import { describe, expect, it } from "vitest";
import { HARNESS_DEFINITIONS } from "../../src/harness-registry.js";

/** How each harness spells Resin's invoke_tool meta tool. */
const INVOKE_TOOL_SPELLING: Record<string, string> = {
  "claude-code": "mcp__resin__invoke_tool",
  "codex-cli": "mcp__resin__invoke_tool",
  omp: "xd://mcp__resin_invoke_tool",
  pi: "mcp__resin__invoke_tool",
  "cursor-cli": "`invoke_tool`",
  "grok-build": "resin__invoke_tool",
  "muse-code": "mcp__resin__invoke_tool",
  opencode: "resin_invoke_tool",
  "copilot-cli": "resin-invoke_tool",
};

const guided = HARNESS_DEFINITIONS.flatMap((definition) =>
  definition.guidance ? [{ id: definition.id, body: definition.guidance.body }] : [],
);

describe("harness guidance text", () => {
  it("covers every harness that installs guidance", () => {
    expect(guided.map((entry) => entry.id).sort()).toEqual(
      Object.keys(INVOKE_TOOL_SPELLING).sort(),
    );
    expect(guided).toHaveLength(9);
  });

  describe.each(guided)("$id", ({ id, body }) => {
    it("does not claim learned tools exist", () => {
      expect(body).not.toMatch(/Resin learned tools from|may have left/);
      expect(body).toContain("may have learned tools");
    });

    it("points at the search_tools description for the learned-tool count", () => {
      expect(body).toMatch(/description says how many learned tools/);
    });

    it("tells the agent not to search when there are none", () => {
      expect(body).toMatch(/there are none, do the task directly/);
    });

    it("runs a found tool directly instead of via get_tool_schema", () => {
      expect(body).not.toMatch(/get_tool_schema[^\n]*(to see|shows) its commands/);
      for (const line of body.split("\n")) {
        const schema = line.indexOf("get_tool_schema");
        const invoke = line.indexOf("invoke_tool", schema);
        if (schema >= 0 && invoke > schema) {
          // Only the meta-tool list may name get_tool_schema before invoke_tool.
          expect(line).toMatch(/lists only/);
        }
      }
      expect(body).toContain(INVOKE_TOOL_SPELLING[id]);
    });
  });
});
