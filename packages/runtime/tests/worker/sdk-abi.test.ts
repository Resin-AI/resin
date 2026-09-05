import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const candidatePath = fileURLToPath(new URL("../../candidate-abi-check.ts", import.meta.url));
function check(source: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, createNew) =>
    path.resolve(name) === candidatePath
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, createNew);
  const program = ts.createProgram({ rootNames: [candidatePath], options, host });
  return program
    .getSemanticDiagnostics(program.getSourceFile(candidatePath))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

describe("public generated-tool ABI declarations", () => {
  it("accepts explicit public ToolContext and contextually types broker access", () => {
    expect(
      check(`
      import {defineTool, type ToolContext} from "./src/index.js";
      const explicit = defineTool(async (context: ToolContext<{path: string}>) => {
        await context.logger.info("Reading");
        return context.broker.fs.readFile(context.input.path, "utf-8");
      });
      const inferred = defineTool<{path: string}, boolean>(async context => {
        return context.broker.fs.exists(context.input.path);
      });
    `),
    ).toEqual([]);
  });
  it("does not erase broker or input types", () => {
    const errors = check(`
      import {defineTool} from "./src/index.js";
      defineTool<{path: string}, boolean>(async context => {
        await context.broker.fs.readFile(42);
        return context.input.path;
      });
    `);
    expect(errors.some((error) => error.includes("number"))).toBe(true);
    expect(errors.some((error) => error.includes("boolean"))).toBe(true);
  });
});
