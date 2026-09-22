import { describe, expect, it } from "vitest";
import { inspectArtifactImports, staticAnalyzeCandidate } from "../../src/index.js";

describe("artifact import inspection", () => {
  it("follows local helpers and literal dynamic imports while allowing the runtime SDK", () => {
    const result = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        [
          "src/index.ts",
          `import { defineTool } from "@resin/runtime";
           export { helper } from "./helper.ts";
           export default defineTool(async () => ({ value: (await import("./helper.ts")).helper }));`,
        ],
        ["src/helper.ts", "export const helper = 42;"],
      ]),
    });

    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("rejects direct and transitive unsupported host imports", () => {
    const direct = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `import "node:crypto"; export const value = 1;`]]),
    });
    expect(direct.passed).toBe(false);
    expect(direct.errors.some((error) => error.includes("node:crypto"))).toBe(true);

    const transitive = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        ["src/index.ts", `export { value } from "./helper.ts";`],
        ["src/helper.ts", `import crypto from "node:crypto"; export const value = crypto;`],
      ]),
    });
    expect(transitive.passed).toBe(false);
    expect(transitive.errors.some((error) => error.includes("node:crypto"))).toBe(true);
  });

  it("uses AST imports rather than matching comments or string contents", () => {
    const result = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        [
          "src/index.ts",
          `// import "node:crypto";
           /* require("node:fs") and import("node:child_process") */
           const text = "import 'node:tls'";
           export const value = text;`,
        ],
      ]),
    });

    expect(result).toEqual({ passed: true, errors: [] });
  });

  it("rejects dynamic non-literals, require, and import-equals syntax", () => {
    const dynamic = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        ["src/index.ts", `const name = "./helper"; export const value = import(name);`],
      ]),
    });
    expect(dynamic.passed).toBe(false);

    const requireResult = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `const value = require("@resin/runtime");`]]),
    });
    expect(requireResult.passed).toBe(false);

    const shadowedRequire = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        [
          "src/index.ts",
          `function invoke(require: (value: string) => unknown) { return require("@resin/runtime"); }
           export const value = invoke;`,
        ],
      ]),
    });
    expect(shadowedRequire).toEqual({ passed: true, errors: [] });

    const importEquals = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `import runtime = require("@resin/runtime");`]]),
    });
    expect(importEquals.passed).toBe(false);
  });

  it("rejects missing and artifact-root-escaping relative imports", () => {
    const missing = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `export { value } from "./missing.ts";`]]),
    });
    expect(missing.passed).toBe(false);

    const extensionless = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        ["src/index.ts", `export { value } from "./helper";`],
        ["src/helper.ts", `export const value = 1;`],
      ]),
    });
    expect(extensionless.passed).toBe(false);

    const urlSyntax = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        [
          "src/index.ts",
          `export { encoded } from "./%2e%2e/outside.ts";
           export { query } from "./helper.ts?fake.ts";
           export { fragment } from "./helper.ts#fake.ts";`,
        ],
        ["src/%2e%2e/outside.ts", "export const encoded = 1;"],
        ["src/helper.ts?fake.ts", "export const query = 1;"],
        ["src/helper.ts#fake.ts", "export const fragment = 1;"],
      ]),
    });
    expect(urlSyntax.passed).toBe(false);

    const nonCode = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        ["src/index.ts", `export { config } from "./config.json";`],
        ["src/config.json", `{ "config": true }`],
      ]),
    });
    expect(nonCode.passed).toBe(false);

    const cjs = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([
        ["src/index.ts", `export { value } from "./helper.cjs";`],
        ["src/helper.cjs", `module.exports = { value: 1 };`],
      ]),
    });
    expect(cjs.passed).toBe(false);

    const commonjsPackage = inspectArtifactImports({
      entrypoint: "src/index.js",
      files: new Map([
        ["src/index.js", `export const value = 1;`],
        ["package.json", JSON.stringify({ type: "commonjs" })],
      ]),
    });
    expect(commonjsPackage.passed).toBe(false);

    const modulePackage = inspectArtifactImports({
      entrypoint: "src/index.js",
      files: new Map([
        ["src/index.js", `export const value = 1;`],
        ["package.json", JSON.stringify({ type: "module" })],
      ]),
    });
    expect(modulePackage).toEqual({ passed: true, errors: [] });

    const malformedPackage = inspectArtifactImports({
      entrypoint: "src/index.js",
      files: new Map([
        ["src/index.js", `export const value = 1;`],
        ["package.json", `{"type":`],
      ]),
    });
    expect(malformedPackage.passed).toBe(false);

    const escaping = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `export { value } from "../../outside.ts";`]]),
    });
    expect(escaping.passed).toBe(false);
  });

  it("rejects syntax errors and keeps the analyzer default allowlist aligned", () => {
    const syntax = inspectArtifactImports({
      entrypoint: "src/index.ts",
      files: new Map([["src/index.ts", `export const broken = ;`]]),
    });
    expect(syntax.passed).toBe(false);

    const defaultAnalysis = staticAnalyzeCandidate(`import "node:crypto"; export const value = 1;`);
    expect(defaultAnalysis.passed).toBe(false);
    expect(
      defaultAnalysis.findings.some(
        (finding) => finding.category === "nondeterministic_dependency",
      ),
    ).toBe(true);

    const configuredAnalysis = staticAnalyzeCandidate(
      `import "node:crypto"; export const value = 1;`,
      undefined,
      { allowedImports: ["node:crypto"] },
    );
    expect(configuredAnalysis.passed).toBe(true);
  });
});
