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
import type { ToolManifest } from "@resin/contracts";
import { derivationHeader, derivationInputTokenIndexes, embeddedPrograms } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_TOOL_PROTOCOL_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  createToolProtocolAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

    expect(executor.describeRecordedWorkflow(installed.artifactDigest, context)).toBe(
      `Recorded on this machine:\nStep 1 runs this recorded shell program:\n${program}`,
    );
    const otherDir = path.join(tempDir, "other-workspace");
    fs.mkdirSync(otherDir);
    const other = resolveWorkspaceContext({ cwd: otherDir });
    expect(other.workspaceId).not.toBe(context.workspaceId);
    expect(executor.describeRecordedWorkflow(installed.artifactDigest, other)).toBeUndefined();
  });

  it("describes a parameterized recorded program with each parameter's recorded value", async () => {
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
          { name: "text", type: "string", recordedDefault: true },
        ],
        privateReferences: ["private:sess:1"],
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
                  template: {
                    type: "program",
                    language: "shell",
                    source: { type: "private", reference: "private:sess:1" },
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
    // Each bound token reads as its input, and each input's recorded value is listed once.
    expect(description).toContain("python3 solve.py --month {month} {text}\n");
    expect(description).toContain("month = 2025-01; text = EU zone");
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
    const shellStep = (id: string, callId: string, template: unknown) => ({
      id,
      callId,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source: "", argument: "command" },
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
          shellStep("step0", "call_1", { type: "private", reference: "private:create" }),
          shellStep("step1", "call_2", {
            type: "program",
            language: "shell",
            source: { type: "private", reference: "private:wait" },
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
              program: { kind: "shell", source: "", argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    source: { type: "private", reference: "private:report" },
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
    const writing = await invoke(
      `open(${JSON.stringify(escaped)}, "w").write("x")\n${lookup}`,
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
              program: { kind: "shell", source: "", argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    source: { type: "private", reference: "private:sess:2" },
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
              program: { kind: "shell", source: "", argument: "command" },
            },
            arguments: [
              {
                name: "command",
                source: {
                  kind: "template",
                  template: {
                    type: "program",
                    language: "shell",
                    source: { type: "private", reference: "private:sess:3" },
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
    expect(seen[0]!.parameters).toEqual({ rows: '{"rows": [1, 2, 3]}\n' });
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
});
