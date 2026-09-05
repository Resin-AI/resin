import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityBrokerManager } from "../../src/brokers/manager.js";
import { createInvocationGrant } from "../../src/policy/grant.js";
import { compileAndTypeCheck } from "../../src/verifier/compiler.js";
import { ToolRuntime } from "../../src/worker/runner.js";

const manifest = {
  id: "compiled-git-tool",
  name: "compiled_git_tool",
  version: "1.0.0",
  description: "Stage and commit one file through the command broker",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, message: { type: "string" } },
    required: ["path", "message"],
    additionalProperties: false,
  },
};

const source = `import { defineTool, type ToolContext } from "@resin/runtime";
export default defineTool(async (context: ToolContext<{path: string; message: string}>) => {
  const { path, message } = context.input;
  const add = await context.broker.cmd.exec("git", ["add", path]);
  if (add.exitCode !== 0) throw new Error(add.stderr);
  const commit = await context.broker.cmd.exec("git", ["commit", "-m", message]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  const status = await context.broker.cmd.exec("git", ["status", "--porcelain"]);
  return { committed: true, status: status.stdout };
});`;

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("compiled generated-tool execution", () => {
  it.each(["compiled", "source"])(
    "executes the %s artifact through the VM and really commits via brokers",
    async (artifactKind) => {
      const compiled = compileAndTypeCheck(source);
      expect(compiled.errors).toEqual([]);
      expect(compiled.passed).toBe(true);
      // Do not break the Deno worker by globally changing published artifacts to CommonJS.
      expect(compiled.jsCode).toContain('from "@resin/runtime"');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "resin-compiled-git-"));
      temporaryRoots.push(root);
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "--quiet");
      git("config", "user.name", "Resin Test");
      git("config", "user.email", "resin-test@example.invalid");
      fs.writeFileSync(path.join(root, "notes.txt"), "A real committed change\n");
      const grant = createInvocationGrant({
        grantId: "grant-compiled-git",
        invocationId: "inv-compiled-git",
        toolId: manifest.id,
        toolVersion: manifest.version,
        workspaceId: "ws-compiled-test",
        envelopeId: "env-compiled-test",
        capabilities: {
          command: {
            allowShellExecution: false,
            allowedCommands: ["git add $PATH", "git commit -m $STR", "git status --porcelain"],
          },
        },
      });
      const brokerManager = new CapabilityBrokerManager({
        workspaceRoot: root,
        allowUnverifiedBoundaries: true,
        development: true,
      });
      const runtime = new ToolRuntime({ mode: "in-process" });
      const result = await runtime.executeTool(
        manifest,
        artifactKind === "source" ? source : compiled.jsCode!,
        { path: "notes.txt", message: "test: real generated commit" },
        {
          workspaceRoot: root,
          brokerManager,
          grant,
          allowUnverifiedBoundaries: true,
          development: true,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe("success");
      expect(result.output).toEqual({ committed: true, status: "" });
      expect(git("rev-list", "--count", "HEAD").trim()).toBe("1");
      expect(git("show", "HEAD:notes.txt")).toBe("A real committed change\n");
      expect(git("status", "--porcelain")).toBe("");
    },
  );

  it.each(["node:fs", "node:child_process", "@resin/runtime/worker", "./arbitrary.js"])(
    "rejects ESM imports outside the approved SDK: %s",
    async (specifier) => {
      const runtime = new ToolRuntime({ mode: "in-process" });
      const result = await runtime.executeTool(
        { ...manifest, parameters: { type: "object", properties: {} } },
        `import * as ambient from ${JSON.stringify(specifier)}; export default () => ambient;`,
        {},
      );
      expect(result.status).toBe("error");
      expect(result.error?.message).toContain("Permission Denied: direct require(");
    },
  );

  it("exposes only the sandbox-local SDK, not host runtime exports", async () => {
    const runtime = new ToolRuntime({ mode: "in-process" });
    const result = await runtime.executeTool(
      { ...manifest, parameters: { type: "object", properties: {} } },
      `import * as sdk from "@resin/runtime";
       export default sdk.defineTool(() => ({
         hostRuntime: "ToolRuntime" in sdk,
         immutable: Object.isFrozen(sdk),
         hostProcess: require.constructor("return process")() === process,
       }));`,
      {},
    );
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ hostRuntime: false, immutable: true, hostProcess: true });
  });
});
