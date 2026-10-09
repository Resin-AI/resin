/**
 * A recorded workflow made of ordinary calls, executed by the real local executor.
 *
 * These tests drive `LocalArtifactExecutor` the way the gateway does, with a verified bundle whose
 * entrypoint is a frozen plan. They check the two things an ordinary call needs that a routed tool
 * call does not: the recorded program is run whole on the host, and the values the plan references —
 * including the program text itself — are resolved locally rather than uploaded.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolManifest, WorkflowValueTemplate } from "@resin/contracts";
import { derivationHeader, derivationInputTokenIndexes, embeddedPrograms } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  RecordedExecutionClock,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { composedResultValue } from "../../src/meta/invoke-tool.js";
import { RESIN_OUTPUT_STEPS_META } from "../../src/protocol/types.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { resolveWorkspaceContext } from "../../src/workspace-resolver.js";

interface TestManifestInput {
  id: string;
  name: string;
  version: string;
  description: string;
  parameters: ToolManifest["parameters"];
  runtime: ToolManifest["runtime"];
  capabilities?: ToolManifest["capabilities"];
}

const WORKSPACE_ID = "ws_native_executor";

/**
 * A program template's source as the recorder projects one: the sanitized text the plan carries
 * (here nothing was redacted, so it is the program itself) and its original behind `reference`.
 */
function projectedSource(reference: string, text: string) {
  return {
    source: { type: "literal" as const, value: text },
    sourceReference: reference,
    protectedTokens: [],
  };
}

describe("recorded workflows of ordinary calls", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "native-executor-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort.
    }
  });

  async function installPlan(
    manifestInput: TestManifestInput,
    plan: unknown,
  ): Promise<{ manifest: ToolManifest; artifactDigest: string; manifestDigest: string }> {
    const manifestWithDefaults = {
      capabilities: {},
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-09-02T00:00:00.000Z",
      ...manifestInput,
    };
    const manifestDigest = computeManifestDigest(manifestWithDefaults as ToolManifest);
    const fullManifest = { ...manifestWithDefaults, digest: manifestDigest } as ToolManifest;
    const entrypoint = JSON.stringify(compileRecordedWorkflow(plan as never).plan);
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(fullManifest) },
      { path: "src/index.ts", content: entrypoint },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
    const stagingDir = await cache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(fullManifest), "utf8");
    fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
    await cache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });
    return { manifest: fullManifest, artifactDigest, manifestDigest };
  }

  function execute(
    input: {
      manifest: ToolManifest;
      artifactDigest: string;
      privateValues: InMemoryPrivateValueStore;
      stepInvoker?: (request: {
        name: string;
        parameters: Record<string, unknown>;
      }) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
    },
    parameters: Record<string, unknown>,
    context = resolveWorkspaceContext({ cwd: workspaceDir }),
  ) {
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: input.privateValues,
      ...(input.stepInvoker ? { stepInvoker: input.stepInvoker } : {}),
      // The host runs the recorded program itself; the family names come from the recording.
      recordedWorkflowAdapters: (host) => [
        createProcessAdapter({ cwd: workspaceDir }),
        createProgramAdapter({ cwd: workspaceDir }),
        createToolProtocolAdapter({
          dispatch: async (request) => {
            const result = await host.routeToHost({
              name: request.name,
              ...(request.connection ? { connection: request.connection } : {}),
              parameters: request.arguments as Record<string, unknown>,
            });
            if (result.isError === true) {
              throw new Error(`callable '${request.name}' answered with an error`);
            }
            const text = result.content?.find((item) => item.type === "text")?.text;
            if (typeof text !== "string") return null;
            try {
              return JSON.parse(text) as never;
            } catch {
              return text as never;
            }
          },
        }),
      ],
    });
    return executor.execute({
      entry: {
        toolId: input.manifest.id,
        name: input.manifest.name,
        version: input.manifest.version,
        artifactDigest: input.artifactDigest,
      },
      manifest: input.manifest,
      parameters: parameters as never,
      context,
    });
  }

  it("runs the recorded program whole, with its operators and redirections", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program =
      "printf 'b\\na\\nc\\n' > seed.txt && sort seed.txt | tr 'a-z' 'A-Z' > upper.txt && wc -l < upper.txt";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", program, { workspaceId: context.workspaceId });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_process",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_process_001",
        name: "wf_process",
        version: "1.0.0",
        description: "recorded process program",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      plan,
    );

    const result = await execute({ ...installed, privateValues }, {}, context);
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceDir, "upper.txt"), "utf8")).toBe("A\nB\nC\n");
    expect(result.content[0]?.text).toContain("3");
  });

  it("times the recorded program's run on the invocation's clock, not the executor's own work", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program = "sleep 0.2 && echo done";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", program, { workspaceId: context.workspaceId });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_sleep",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_sleep_001",
        name: "wf_sleep",
        version: "1.0.0",
        description: "recorded sleeping program",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      plan,
    );

    const clock = new RecordedExecutionClock();
    const started = performance.now();
    const result = await clock.run(() => execute({ ...installed, privateValues }, {}, context));
    const total = performance.now() - started;
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    const execution = clock.durationMs() ?? 0;
    expect(execution).toBeGreaterThanOrEqual(190);
    expect(execution).toBeLessThanOrEqual(Math.ceil(total));
    // The measurement stays with the clock; the result carries none of it.
    expect(JSON.stringify(result)).not.toMatch(/execution/i);
  });

  it("describes a cached recorded program only to the workspace that recorded it", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program = "python3 -m pytest tests/test_grouping.py -q";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", program, { workspaceId: context.workspaceId });
    const installed = await installPlan(
      {
        id: "tool_process_described",
        name: "wf_process_described",
        version: "1.0.0",
        description: "recorded process program",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_described",
        inputs: [],
        privateReferences: ["private:sess:0"],
        steps: [
          {
            id: "step0",
            callId: "call_1",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: { kind: "shell", source: "", argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: { type: "private", reference: "private:sess:0" },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });

    // A program recorded wholly as a private value is shown as its placeholder, never resolved.
    expect(executor.describeRecordedWorkflow(installed.artifactDigest, context)).toBe(
      "Recorded on this machine:\nStep 1 runs this recorded shell program:\n<private:1>",
    );
    // A program recorded wholly as a private value has no projected text to name a command from.
    expect(executor.recordedWorkflowCommands(installed.artifactDigest, context)).toEqual([]);
    const otherDir = path.join(tempDir, "other-workspace");
    fs.mkdirSync(otherDir);
    const other = resolveWorkspaceContext({ cwd: otherDir });
    expect(other.workspaceId).not.toBe(context.workspaceId);
    expect(executor.describeRecordedWorkflow(installed.artifactDigest, other)).toBeUndefined();
    expect(executor.recordedWorkflowCommands(installed.artifactDigest, other)).toEqual([]);
  });

  it("names commands from the projected program, never from a resolved private value", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    const owner = { workspaceId: context.workspaceId };
    // A projected program: the recording's sanitized text, its original kept as a private value.
    const original = "canarysecrettool --flag 1; gh pr checks 7";
    const sanitized = "[REDACTED_HIGH_ENTROPY_SECRET:7ffcc398bd861a0c] --flag 1; gh pr checks 7";
    privateValues.set("private:projected", original, owner);
    // A program recorded wholly as a private value: nothing may be read from it.
    privateValues.set("private:legacy", "canarylegacytool run", owner);
    // Canary private values of the plan, which no command may name even if a program spells them.
    privateValues.set("private:user", "canaryuser", owner);
    privateValues.set("private:script", "scripts/canaryscript.py", owner);
    const shell = (id: string, template: WorkflowValueTemplate, source = "") => ({
      id,
      callId: `call_${id}`,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell" as const, source, argument: "command" },
      },
      arguments: [{ name: "command", source: { kind: "template" as const, template } }],
      dependsOn: [],
      failurePolicy: { onError: "abort" as const, policy: "default" as const },
      observed: { outcome: "succeeded" as const },
    });
    const installed = await installPlan(
      {
        id: "tool_process_private_commands",
        name: "wf_process_private_commands",
        version: "1.0.0",
        description: "recorded process programs with private values",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_private_commands",
        inputs: [],
        privateReferences: [
          "private:projected",
          "private:legacy",
          "private:user",
          "private:script",
        ],
        steps: [
          shell(
            "step0",
            {
              type: "program",
              language: "shell",
              source: { type: "literal", value: sanitized },
              sourceReference: "private:projected",
              protectedTokens: [0],
              holes: [],
            },
            sanitized,
          ),
          shell("step1", { type: "private", reference: "private:legacy" }),
          shell("step2", {
            type: "literal",
            value:
              "sudo -u canaryuser stylua src; env -u canaryuser selene src; python3 scripts/canaryscript.py",
          }),
          shell("step3", { type: "private", reference: "private:user" }),
          shell("step4", { type: "private", reference: "private:script" }),
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });

    const commands = executor.recordedWorkflowCommands(installed.artifactDigest, context);
    expect(commands).toEqual(["gh pr checks", "stylua", "selene"]);
    expect(JSON.stringify(commands)).not.toMatch(/canary/u);

    // Per step, read the same way: a program kept private names nothing and counts as writing.
    const steps = executor.recordedWorkflowSteps(installed.artifactDigest, context);
    expect(steps).toHaveLength(5);
    expect(steps?.[0]).toEqual({ commands: ["gh pr checks"] });
    expect(steps?.[2]).toEqual({ commands: ["stylua", "selene"] });
    expect(steps?.[1]?.commands).toEqual([]);
    expect(JSON.stringify(steps)).not.toMatch(/canary/u);
  });

  it("describes a harness tool step by its tool and the arguments a caller sees", async () => {
    // A job that writes a file and then validates it: the write is the first step the tool covers,
    // so the description shows it, with `{input}` where a caller's value goes — whether the input
    // is a whole argument (an accepted whole-argument binding) or a template leaf — and without
    // OMP's `i` narration, which old recordings still carry as an argument.
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:2", "python3 scripts/validate.py sources/orders_001.json", {
      workspaceId: context.workspaceId,
    });
    privateValues.set("private:sess:3", "Creating the source", {
      workspaceId: context.workspaceId,
    });
    const installed = await installPlan(
      {
        id: "tool_write_then_validate",
        name: "wf_write_then_validate",
        version: "1.0.0",
        description: "write then validate",
        parameters: {
          type: "object",
          properties: { content: { type: "string" }, target: { type: "string" } },
          required: ["content", "target"],
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_write_then_validate",
        inputs: [
          { name: "content", type: "string" },
          { name: "target", type: "string" },
        ],
        privateReferences: ["private:sess:2", "private:sess:3"],
        steps: [
          {
            id: "step0",
            callId: "call_w",
            callable: { runtime: RESIN_HARNESS_TOOL_RUNTIME, name: "write" },
            arguments: [
              {
                name: "path",
                source: {
                  kind: "template",
                  template: { type: "input", name: "target" },
                },
              },
              {
                name: "content",
                source: { kind: "input", name: "content" },
              },
              {
                name: "i",
                source: {
                  kind: "template",
                  template: { type: "private", reference: "private:sess:3" },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
          {
            id: "step1",
            callId: "call_v",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: {
                kind: "shell",
                source: "python3 scripts/validate.py sources/orders_001.json",
                argument: "command",
              },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    ...projectedSource(
                      "private:sess:2",
                      "python3 scripts/validate.py sources/orders_001.json",
                    ),
                    holes: [],
                  },
                },
              },
            ],
            dependsOn: ["step0"],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });
    expect(executor.describeRecordedWorkflow(installed.artifactDigest, context)).toBe(
      "Recorded on this machine:\n" +
        "Step 1 calls the harness's write tool with path = {target}, content = {content}\n" +
        "Step 2 runs this recorded shell program:\npython3 scripts/validate.py sources/orders_001.json",
    );
  });

  it("describes a composed harness argument as its literals around `{input}`", async () => {
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    const installed = await installPlan(
      {
        id: "tool_write_composed",
        name: "wf_write_composed",
        version: "1.0.0",
        description: "write a composed path",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: {},
      },
      {
        schemaVersion: 1,
        workflowId: "wf_write_composed",
        inputs: [{ name: "text", type: "string" }],
        steps: [
          {
            id: "step0",
            callId: "call_w",
            callable: { runtime: RESIN_HARNESS_TOOL_RUNTIME, name: "write" },
            arguments: [
              {
                name: "path",
                source: {
                  kind: "template",
                  template: {
                    type: "text",
                    parts: [
                      { type: "literal", value: "sources/" },
                      { type: "input", name: "text" },
                      { type: "literal", value: ".json" },
                    ],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: new InMemoryPrivateValueStore(),
    });
    expect(executor.describeRecordedWorkflow(installed.artifactDigest, context)).toBe(
      "Recorded on this machine:\nStep 1 calls the harness's write tool with path = sources/{text}.json",
    );
  });

  it("lists the recorded value only of a parameter that runs it when omitted", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program = "python3 solve.py --month 2025-01 'EU zone'";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:1", program, { workspaceId: context.workspaceId });
    const installed = await installPlan(
      {
        id: "tool_process_parameterized",
        name: "wf_process_parameterized",
        version: "1.0.0",
        description: "parameterized recorded process program",
        parameters: {
          type: "object",
          properties: { month: { type: "string" }, text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_parameterized",
        inputs: [
          { name: "month", type: "string", recordedDefault: true },
          { name: "text", type: "string" },
        ],
        privateReferences: ["private:sess:1"],
        steps: [
          {
            id: "step0",
            callId: "call_1",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: { kind: "shell", source: program, argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    ...projectedSource("private:sess:1", program),
                    holes: [
                      { token: 3, binding: { type: "input", name: "month" } },
                      { token: 4, binding: { type: "input", name: "text" } },
                    ],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });

    const description = executor.describeRecordedWorkflow(installed.artifactDigest, context);
    // Each bound token reads as its input. Only `month` falls back on its recorded value; `text`
    // is required, so its recorded value is never claimed as one that runs.
    expect(description).toContain("python3 solve.py --month {month} {text}\n");
    expect(description).toContain(
      "\nParameters (each replaces its {name} above; omitted, the recorded value runs): month = 2025-01",
    );
    expect(description).not.toContain("EU zone");
  });

  it("names the printing step at a token bound to an earlier step's output", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    const owned = { workspaceId: context.workspaceId };
    privateValues.set("private:create", "./deployctl create", owned);
    privateValues.set("private:wait", "./deployctl wait dep-9e983a", owned);
    privateValues.set(
      "private:locator",
      JSON.stringify({ before: "deployment ", charset: ["lower", "digit", "-"] }),
      owned,
    );
    const shellStep = (id: string, callId: string, source: string, template: unknown) => ({
      id,
      callId,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source, argument: "command" },
      },
      arguments: [{ name: "command", source: { kind: "template", template } }],
      dependsOn: [],
      failurePolicy: { onError: "abort", policy: "default" },
      observed: { outcome: "succeeded" },
    });
    const installed = await installPlan(
      {
        id: "tool_process_extract",
        name: "wf_process_extract",
        version: "1.0.0",
        description: "recorded program reading a printed id",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_extract",
        inputs: [],
        privateReferences: ["private:create", "private:wait", "private:locator"],
        steps: [
          shellStep("step0", "call_1", "./deployctl create", {
            type: "program",
            language: "shell",
            ...projectedSource("private:create", "./deployctl create"),
            holes: [],
          }),
          shellStep("step1", "call_2", "./deployctl wait dep-9e983a", {
            type: "program",
            language: "shell",
            ...projectedSource("private:wait", "./deployctl wait dep-9e983a"),
            holes: [
              {
                token: 2,
                binding: { type: "extract", stepId: "step0", locator: "private:locator" },
              },
            ],
          }),
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });
    const description = executor.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain("./deployctl wait {output of step 1}");
    expect(description).not.toContain("dep-9e983a");
    expect(description).not.toContain("Parameters");
  });

  it("describes a derivation by what it computes, never its code or computed values", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:report", "printf '%s %s %s\\n' Crossfit_Hanna R 5942", {
      workspaceId: context.workspaceId,
    });
    const code = `${derivationHeader([{ name: "merchant", value: "" }])}import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n`;
    const [merchantToken] = derivationInputTokenIndexes(code, ["merchant"]);
    const installed = await installPlan(
      {
        id: "tool_derivation",
        name: "wf_derivation",
        version: "1.0.0",
        description: "recorded report with derived values",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_derivation",
        inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
        privateReferences: ["private:report"],
        steps: [
          {
            id: "derive",
            callId: "derivation:derive",
            origin: "derivation",
            callable: {
              runtime: RESIN_PROGRAM_RUNTIME,
              name: "python",
              program: {
                kind: "python",
                sourceInterface: "python-eval",
                source: code,
                argument: "code",
              },
            },
            arguments: [
              {
                name: "code",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "python",
                    source: { type: "literal", value: code },
                    holes: [{ token: merchantToken, binding: { type: "input", name: "merchant" } }],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "unknown" },
          },
          {
            id: "report",
            callId: "call_report",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: {
                kind: "shell",
                source: "printf '%s %s %s\\n' Crossfit_Hanna R 5942",
                argument: "command",
              },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    ...projectedSource(
                      "private:report",
                      "printf '%s %s %s\\n' Crossfit_Hanna R 5942",
                    ),
                    holes: [
                      { token: 2, binding: { type: "input", name: "merchant" } },
                      {
                        token: 3,
                        binding: { type: "result", stepId: "derive", path: ["account_type"] },
                      },
                      { token: 4, binding: { type: "result", stepId: "derive", path: ["mcc"] } },
                    ],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });
    const description = executor.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain("Step 1 computes {account_type}, {mcc} from {merchant}");
    expect(description).toContain("printf '%s %s %s\\n' {merchant} {account_type} {mcc}");
    expect(description).not.toContain("json.load");
    // Only the caller input is a parameter; derived values are neither parameters nor shown.
    expect(description).toContain("merchant = Crossfit_Hanna");
    expect(description).not.toContain("account_type =");
    expect(description).not.toContain("5942");
  });

  it("runs a learned tool's derivation step sandboxed when the tool is invoked", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    const lookup =
      'merchants = {"Crossfit_Hanna": {"account_type": "R", "mcc": 5942}}\nm = merchants[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n';
    const invoke = async (body: string, name: string) => {
      const code = `${derivationHeader([{ name: "merchant", value: "" }])}${body}`;
      const [merchantToken] = derivationInputTokenIndexes(code, ["merchant"]);
      const installed = await installPlan(
        {
          id: `tool_${name}`,
          name,
          version: "1.0.0",
          description: "derived values",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          runtime: {
            runtime: "recorded-workflow",
            memoryLimitMb: 64,
            timeoutMs: 10_000,
            cpuLimitPercent: 100,
            maxOutputSizeBytes: 65_536,
          },
          capabilities: { command: { allowShellExecution: true } },
        },
        {
          schemaVersion: 1,
          workflowId: name,
          inputs: [{ name: "merchant", type: "string" }],
          steps: [
            {
              id: "derive",
              callId: "derivation:derive",
              origin: "derivation",
              callable: {
                runtime: RESIN_PROGRAM_RUNTIME,
                name: "python",
                program: {
                  kind: "python",
                  sourceInterface: "python-eval",
                  source: code,
                  argument: "code",
                },
              },
              arguments: [
                {
                  name: "code",
                  source: {
                    kind: "template",
                    template: {
                      type: "program",
                      language: "python",
                      source: { type: "literal", value: code },
                      holes: [
                        { token: merchantToken, binding: { type: "input", name: "merchant" } },
                      ],
                    },
                  },
                },
              ],
              dependsOn: [],
              failurePolicy: { onError: "abort", policy: "default" },
              observed: { outcome: "unknown" },
            },
          ],
        },
      );
      return execute({ ...installed, privateValues }, { merchant: "Crossfit_Hanna" }, context);
    };
    const allowed = await invoke(lookup, "wf_derive_ok");
    expect(allowed.isError, String(allowed.content[0]?.text)).toBeUndefined();
    expect(allowed.content[0]?.text).toContain("5942");
    const escaped = path.join(workspaceDir, "escaped.txt");
    // Forward slashes name the same host file on Windows, where Pyodide's POSIX filesystem would
    // otherwise take `C:\…\escaped.txt` for one bare file name in its own working directory.
    const writing = await invoke(
      `open(${JSON.stringify(escaped.split(path.sep).join("/"))}, "w").write("x")\n${lookup}`,
      "wf_derive_write",
    );
    expect(writing.isError).toBe(true);
    expect(fs.existsSync(escaped)).toBe(false);
  }, 60_000);

  it("shows an input placeholder inside a heredoc body the recorded program embeds", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program = "python3 - <<'PY'\nprint('Belles_cookbook_store')\nPY";
    const heredoc = embeddedPrograms(program)[0]!;
    const embedded = heredoc.tokens.findIndex((token) => token.raw === "'Belles_cookbook_store'");
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:2", program, { workspaceId: context.workspaceId });
    const installed = await installPlan(
      {
        id: "tool_process_embedded",
        name: "wf_process_embedded",
        version: "1.0.0",
        description: "recorded python heredoc with a bound literal",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_embedded",
        inputs: [{ name: "text", type: "string", recordedDefault: true }],
        privateReferences: ["private:sess:2"],
        steps: [
          {
            id: "step0",
            callId: "call_1",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: { kind: "shell", source: program, argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    ...projectedSource("private:sess:2", program),
                    holes: [
                      {
                        token: heredoc.anchor,
                        embedded,
                        binding: { type: "input", name: "text" },
                      },
                    ],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });

    const description = executor.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain("python3 - <<'PY'\nprint({text})\nPY");
    expect(description).toContain("text = Belles_cookbook_store");
  });

  it("shows input placeholders at span positions inside a recorded token", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const program =
      "report build --region emea --out out/emea-2025-03/summary.csv --copy 'out/emea-2025-03/copy.csv'";
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:3", program, { workspaceId: context.workspaceId });
    const region = { type: "input" as const, name: "region" };
    const month = { type: "input" as const, name: "month" };
    const installed = await installPlan(
      {
        id: "tool_process_span",
        name: "wf_process_span",
        version: "1.0.0",
        description: "recorded program with span holes",
        parameters: {
          type: "object",
          properties: { region: { type: "string" }, month: { type: "string" } },
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_process_span",
        inputs: [
          { name: "region", type: "string", recordedDefault: true },
          { name: "month", type: "string", recordedDefault: true },
        ],
        privateReferences: ["private:sess:3"],
        steps: [
          {
            id: "step0",
            callId: "call_1",
            callable: {
              runtime: RESIN_PROCESS_RUNTIME,
              name: "bash",
              program: { kind: "shell", source: program, argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    ...projectedSource("private:sess:3", program),
                    holes: [
                      { token: 3, binding: region },
                      { token: 5, span: { start: 4, end: 8 }, binding: region },
                      { token: 5, span: { start: 9, end: 16 }, binding: month },
                      { token: 7, span: { start: 9, end: 16 }, binding: month },
                    ],
                  },
                },
              },
            ],
            dependsOn: [],
            failurePolicy: { onError: "abort", policy: "default" },
            observed: { outcome: "succeeded" },
          },
        ],
      },
    );
    const executor = new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
    });

    const description = executor.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain(
      "report build --region {region} --out out/{region}-{month}/summary.csv --copy 'out/emea-{month}/copy.csv'",
    );
    expect(description).toContain("month = 2025-03");
  });

  it("refuses to run a recorded program the manifest does not grant", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", "printf 'should-not-run' > leaked.txt", {
      workspaceId: context.workspaceId,
    });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_process_ungranted",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROCESS_RUNTIME,
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            {
              name: "command",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_process_002",
        name: "wf_process_ungranted",
        version: "1.0.0",
        description: "recorded process program without a grant",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
      },
      plan,
    );

    const result = await execute({ ...installed, privateValues }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("does not grant command execution");
    expect(fs.existsSync(path.join(workspaceDir, "leaked.txt"))).toBe(false);
  });

  it("runs a recorded program through its interpreter and dispatches a tool by name", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues.set("private:sess:0", "import json\nprint(json.dumps({'rows': [1, 2, 3]}))\n", {
      workspaceId: context.workspaceId,
    });
    const plan = {
      schemaVersion: 1,
      workflowId: "wf_program_and_tool",
      inputs: [],
      privateReferences: ["private:sess:0"],
      steps: [
        {
          id: "step0",
          callId: "call_1",
          callable: {
            runtime: RESIN_PROGRAM_RUNTIME,
            name: "eval",
            program: { kind: "python", source: "", argument: "code" },
          },
          arguments: [
            {
              name: "code",
              source: {
                kind: "template",
                template: { type: "private", reference: "private:sess:0" },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
        {
          id: "step1",
          callId: "call_2",
          callable: {
            runtime: RESIN_TOOL_PROTOCOL_RUNTIME,
            name: "vendor.score",
            connection: "vendor-srv",
          },
          arguments: [
            {
              name: "rows",
              source: {
                kind: "template",
                template: { type: "result", stepId: "step0", path: [] },
              },
            },
          ],
          dependsOn: ["step0"],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const installed = await installPlan(
      {
        id: "tool_program_001",
        name: "wf_program_and_tool",
        version: "1.0.0",
        description: "recorded program and a call reached over its connection",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 20_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      plan,
    );

    const seen: Array<{ name: string; parameters: Record<string, unknown> }> = [];
    const result = await execute(
      {
        ...installed,
        privateValues,
        stepInvoker: async (request) => {
          seen.push(request);
          return {
            content: [{ type: "text", text: JSON.stringify({ scored: 12 }) }],
          };
        },
      },
      {},
      context,
    );
    expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
    // The program's answer reached the callable exactly as the program printed it, and the
    // callable was reached by its own name through the host's routing.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe("vendor.score");
    // Python's print ends a line with the platform's newline: CRLF on Windows.
    expect(seen[0]!.parameters).toEqual({ rows: `{"rows": [1, 2, 3]}${os.EOL}` });
  });

  it("runs an optional middle step by default and skips it when its toggle is false", async () => {
    const privateValues = new InMemoryPrivateValueStore();
    const context = resolveWorkspaceContext({ cwd: workspaceDir });
    const commands = [
      "echo one > a.marker; echo first",
      "echo two > b.marker; echo second",
      "echo three > c.marker; echo third",
    ];
    commands.forEach((command, index) =>
      privateValues.set(`private:sess:${index}`, command, {
        workspaceId: context.workspaceId,
      }),
    );
    const step = (index: number) => ({
      id: `step${index}`,
      callId: `call_${index}`,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source: "", argument: "command" },
      },
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: { type: "private", reference: `private:sess:${index}` },
          },
        },
      ],
      dependsOn: [],
      failurePolicy: { onError: "abort", policy: "default" },
      observed: { outcome: "succeeded" },
    });
    const installed = await installPlan(
      {
        id: "tool_optional_steps",
        name: "wf_optional_steps",
        version: "1.0.0",
        description: "recorded plan with an optional step",
        parameters: {
          type: "object",
          properties: { run_step2: { type: "boolean", default: true } },
          additionalProperties: false,
        },
        runtime: {
          runtime: "recorded-workflow",
          memoryLimitMb: 64,
          timeoutMs: 10_000,
          cpuLimitPercent: 100,
          maxOutputSizeBytes: 65_536,
        },
        capabilities: { command: { allowShellExecution: true } },
      },
      {
        schemaVersion: 1,
        workflowId: "wf_optional_steps",
        inputs: [{ name: "run_step2", type: "boolean", default: true }],
        privateReferences: ["private:sess:0", "private:sess:1", "private:sess:2"],
        steps: [step(0), { ...step(1), optional: { input: "run_step2" } }, step(2)],
      },
    );
    const marker = (name: string) => fs.existsSync(path.join(workspaceDir, name));

    const all = await execute({ ...installed, privateValues }, {}, context);
    expect(all.isError, String(all.content[0]?.text)).toBeUndefined();
    expect([marker("a.marker"), marker("b.marker"), marker("c.marker")]).toEqual([
      true,
      true,
      true,
    ]);

    for (const name of ["a.marker", "b.marker", "c.marker"])
      fs.rmSync(path.join(workspaceDir, name));
    const skipped = await execute({ ...installed, privateValues }, { run_step2: false }, context);
    expect(skipped.isError, String(skipped.content[0]?.text)).toBeUndefined();
    expect([marker("a.marker"), marker("b.marker"), marker("c.marker")]).toEqual([
      true,
      false,
      true,
    ]);
    expect(skipped.content[0]?.text).toBe(
      "--- step 1/3 ---\nfirst\n\n--- step 2/3 skipped ---\n--- step 3/3 ---\nthird\n",
    );
  });

  describe("a four-step deploy", () => {
    const shellStep = (index: number) => ({
      id: `step${index}`,
      callId: `call_${index}`,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source: "", argument: "command" },
      },
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: { type: "private", reference: `private:sess:${index}` },
          },
        },
      ],
      dependsOn: [] as string[],
      failurePolicy: { onError: "abort", policy: "default" },
      observed: { outcome: "succeeded" },
    });
    const manifest = (name: string): TestManifestInput => ({
      id: `tool_${name}`,
      name,
      version: "1.0.0",
      description: "recorded four-step deploy",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      runtime: {
        runtime: "recorded-workflow",
        memoryLimitMb: 64,
        timeoutMs: 20_000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 65_536,
      },
      capabilities: { command: { allowShellExecution: true } },
    });
    const record = (commands: Record<number, string>) => {
      const privateValues = new InMemoryPrivateValueStore();
      const context = resolveWorkspaceContext({ cwd: workspaceDir });
      for (const [index, command] of Object.entries(commands)) {
        privateValues.set(`private:sess:${index}`, command, { workspaceId: context.workspaceId });
      }
      return { privateValues, context };
    };

    it("reports a failed step with what already ran, by plan step, and what did not run", async () => {
      const commands = {
        0: "echo created > created.marker; echo created release r-17",
        1: "echo waited; echo ready",
        2: "echo smoke check failed >&2; exit 3",
        3: "echo promoted > promoted.marker; echo promoted",
      };
      const { privateValues, context } = record(commands);
      const installed = await installPlan(manifest("deploy_application"), {
        schemaVersion: 1,
        workflowId: "deploy_application",
        inputs: [],
        privateReferences: Object.keys(commands).map((index) => `private:sess:${index}`),
        steps: [shellStep(0), shellStep(1), shellStep(2), shellStep(3)],
      });

      const result = await execute({ ...installed, privateValues }, {}, context);

      expect(result.isError).toBe(true);
      const text = String(result.content[0]?.text);
      expect(text).toMatch(/^Step 3 of 4 failed: .*exited with code 3: smoke check failed/);
      expect(text).toContain("--- step 1/4 ---\ncreated release r-17\n");
      expect(text).toContain("--- step 2/4 ---\nwaited\nready\n");
      expect(text).toContain("Did not run: step 4/4.");
      expect(text).toContain(
        "Steps 1 and 2 completed and their effects already happened: do not rerun them blindly",
      );
      // The first two steps really ran and the last did not.
      expect(fs.existsSync(path.join(workspaceDir, "created.marker"))).toBe(true);
      expect(fs.existsSync(path.join(workspaceDir, "promoted.marker"))).toBe(false);
      // Only what the steps printed: never the recorded programs themselves.
      for (const command of Object.values(commands)) expect(text).not.toContain(command);
      expect(text).not.toContain("promoted");
    });

    it("labels several outputs with the plan steps that produced them", async () => {
      const commands = {
        0: "echo r-17",
        2: "echo smoke ok",
        3: "echo promoted",
      };
      const { privateValues, context } = record(commands);
      // Step 2 waits on the release step 1 created, so step 1's output is consumed, not returned.
      const wait = {
        id: "step1",
        callId: "call_1",
        callable: { runtime: RESIN_TOOL_PROTOCOL_RUNTIME, name: "deploy.wait", connection: "ops" },
        arguments: [
          {
            name: "release",
            source: { kind: "template", template: { type: "result", stepId: "step0", path: [] } },
          },
        ],
        dependsOn: ["step0"],
        failurePolicy: { onError: "abort", policy: "default" },
        observed: { outcome: "succeeded" },
      };
      const installed = await installPlan(manifest("deploy_outputs"), {
        schemaVersion: 1,
        workflowId: "deploy_outputs",
        inputs: [],
        privateReferences: ["private:sess:0", "private:sess:2", "private:sess:3"],
        steps: [shellStep(0), wait, shellStep(2), shellStep(3)],
      });

      const result = await execute(
        {
          ...installed,
          privateValues,
          stepInvoker: async () => ({ content: [{ type: "text", text: "release is live" }] }),
        },
        {},
        context,
      );

      expect(result.isError, String(result.content[0]?.text)).toBeUndefined();
      // Composition still reads the plain outputs array.
      expect(composedResultValue(result)).toEqual(["release is live", "smoke ok\n", "promoted\n"]);
      expect(result._meta?.[RESIN_OUTPUT_STEPS_META]).toEqual({ steps: [2, 3, 4], total: 4 });
    });
  });
});
