import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("accepts typed and inferred handlers through the published runtime declarations", () => {
  const fileName = fileURLToPath(new URL("./typed-sdk-consumer.mts", import.meta.url));
  const source = `
    import { defineTool, type ToolContext } from "@resin/runtime";
    type Input = { path: string };
    export const typed = defineTool(async (context: ToolContext<Input>) => {
      await context.logger.info("Reading file");
      return context.broker.fs.readFile(context.input.path, "utf-8");
    });
    export const inferred = defineTool<Input, string>(async (context) => {
      await context.broker.fs.exists(context.input.path);
      return context.workspaceRoot;
    });
    export const legacy = defineTool({
      handler: (input: Input, context: ToolContext<Input>) =>
        context.broker.fs.exists(input.path),
    });
  `;
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fileName
      ? ts.createSourceFile(path, source, languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  const errors = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  expect(errors).toEqual([]);
});
