import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ompHarness } from "../src/harness.js";
import { resolveOmpGuidancePath } from "../src/instructions.js";

describe("OMP guidance surface", () => {
  it("resolves the user AGENTS.md under OMP_HOME, else ~/.omp/agent", () => {
    expect(resolveOmpGuidancePath("/home/dev", {})).toBe("/home/dev/.omp/agent/AGENTS.md");
    expect(resolveOmpGuidancePath("/home/dev", { OMP_HOME: "/profiles/omp" })).toBe(
      "/profiles/omp/agent/AGENTS.md",
    );
  });

  it("is installed next to the MCP registration it describes", () => {
    const env = { OMP_HOME: "/profiles/omp" };
    expect(path.dirname(ompHarness.guidance!.resolvePath("/home/dev", env))).toBe(
      path.dirname(ompHarness.mcpConfig.resolvePath("/home/dev", env)),
    );
  });
});
