import { describe, expect, it } from "vitest";
import { CandidateCompiler, compileAndTypeCheck } from "../../src/verifier/compiler.js";

describe("Candidate Compiler and TypeScript Type-Check Verifier", () => {
  const compiler = new CandidateCompiler();

  it("compiles valid TypeScript tool using defineTool and context", () => {
    const validTool = `
      import { defineTool, type ToolContext } from "@resin/runtime";
      import { z } from "zod";

      export const InputSchema = z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().default(10),
      });

      export type InputType = z.infer<typeof InputSchema>;

      export interface OutputType {
        results: string[];
        count: number;
      }

      export default defineTool<InputType, OutputType>(async (context: ToolContext<InputType>) => {
        await context.log("info", "Executing search query", { query: context.input.query });
        await context.progress(50, "Searching");

        const upperQuery = context.input.query.toUpperCase();
        return {
          results: [upperQuery],
          count: 1,
        };
      });
    `;

    const result = compileAndTypeCheck(validTool);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.jsCode).toBeDefined();
    expect(result.jsCode).toContain("defineTool");
  });

  it("compiles tool interacting with mediated brokers", () => {
    const brokerTool = `
      import { defineTool, type ToolContext } from "@resin/runtime";

      interface FetchInput {
        url: string;
      }

      export default defineTool<FetchInput, { status: number }>(async (ctx: ToolContext<FetchInput>) => {
        if (!ctx.broker.net) {
          throw new Error("Network broker required");
        }

        const resp = await ctx.broker.net.fetch(ctx.input.url);
        return { status: resp.status };
      });
    `;

    const result = compiler.compile(brokerTool);
    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects invalid type assignments with TS diagnostics", () => {
    const invalidTypeTool = `
      import { defineTool, type ToolContext } from "@resin/runtime";

      export default defineTool<{ a: number }, { result: number }>(async (ctx) => {
        const text: string = ctx.input.a; // Type error: number is not assignable to string
        return { result: text }; // Type error: string is not assignable to number
      });
    `;

    const result = compileAndTypeCheck(invalidTypeTool);
    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === 2322)).toBe(true);
  });

  it("rejects calling non-existent broker methods", () => {
    const nonExistentMethodTool = `
      import { defineTool, type ToolContext } from "@resin/runtime";

      export default defineTool(async (ctx: ToolContext) => {
        await ctx.broker.fs.nonExistentFsMethod();
        return { done: true };
      });
    `;

    const result = compileAndTypeCheck(nonExistentMethodTool);
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("nonExistentFsMethod"))).toBe(true);
  });

  it("rejects candidate source missing tool export", () => {
    const noExportSource = `
      import { z } from "zod";
      const a = 42;
      function compute() { return a * 2; }
    `;

    const result = compileAndTypeCheck(noExportSource);
    expect(result.passed).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Missing export") || e.includes("must export")),
    ).toBe(true);
  });

  it("rejects syntax errors cleanly", () => {
    const brokenSyntax = `
      import { defineTool } from "@resin/runtime";
      export default defineTool(async () => {
        const x = ; // Syntax error
      });
    `;

    const result = compileAndTypeCheck(brokenSyntax);
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.category === "error")).toBe(true);
  });

  it("enforces strict null checks and implicit any", () => {
    const implicitAny = `
      import { defineTool } from "@resin/runtime";
      export default defineTool(async (ctx) => {
        function helper(untypedParam) { // implicit any error
          return untypedParam;
        }
        return { val: helper(1) };
      });
    `;

    const result = compileAndTypeCheck(implicitAny);
    expect(result.passed).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 7006)).toBe(true);
  });
});
