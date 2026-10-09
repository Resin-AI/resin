/**
 * A learned tool's description reaches the model provider and the harness transcript, so it shows
 * only what the plan itself carries: the sanitized text of a projected program, a `<private:N>`
 * placeholder for each private value, `{input}` for each caller value. Invocation still runs the
 * original program with every private value resolved.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ToolManifest,
  type WorkflowValueTemplate,
  analyzeProgramSourceProjection,
} from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCRUBBED_PRIVATE_VALUE } from "../../src/meta/private-values.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

const ARG_SECRET = "argSecretValue987654";
const URL_SECRET = "urlSecretValue556677";
const ENV_SECRET = "envSecretValue123456";
const HEREDOC_SECRET = "heredocSecretValue42";
const PROFILE_SECRET = "acme-secret-profile-77";
const NATIVE_SECRET = "nativeSecretContent123";
const SECRETS = [ARG_SECRET, URL_SECRET, ENV_SECRET, HEREDOC_SECRET, PROFILE_SECRET, NATIVE_SECRET];

/** A shell step whose program the recorder projected: sanitized text shown, original run. */
function projectedStep(
  id: string,
  reference: string,
  original: string,
  sanitized: string,
  holes: Extract<WorkflowValueTemplate, { type: "program" }>["holes"] = [],
) {
  const { protectedTokens } = analyzeProgramSourceProjection("shell", original, sanitized);
  return {
    id,
    callId: `call_${id}`,
    callable: {
      runtime: RESIN_PROCESS_RUNTIME,
      name: "bash",
      program: { kind: "shell", source: sanitized, argument: "command" },
    },
    arguments: [
      {
        name: "command",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "shell",
            source: { type: "literal", value: sanitized },
            sourceReference: reference,
            protectedTokens,
            holes,
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "succeeded" },
  };
}

describe("learned tool descriptions never show a resolved private value", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;
  let context: WorkspaceContext;
  let privateValues: InMemoryPrivateValueStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "description-privacy-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    context = resolveWorkspaceContext({ cwd: workspaceDir });
    privateValues = new InMemoryPrivateValueStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function own(reference: string, value: string): void {
    privateValues.set(reference, value, { workspaceId: context.workspaceId });
  }

  async function install(
    parameters: ToolManifest["parameters"],
    plan: Record<string, unknown>,
  ): Promise<{ manifest: ToolManifest; artifactDigest: string }> {
    const raw = {
      id: `tool_${String(plan.workflowId)}`,
      name: String(plan.workflowId),
      version: "1.0.0",
      description: "privacy fixture",
      parameters,
      runtime: {
        runtime: "recorded-workflow",
        memoryLimitMb: 64,
        timeoutMs: 20_000,
        cpuLimitPercent: 100,
        maxOutputSizeBytes: 65_536,
      },
      capabilities: { command: { allowShellExecution: true } },
      limits: {},
      scope: "workspace" as const,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    const manifest = { ...raw, digest: computeManifestDigest(raw as ToolManifest) } as ToolManifest;
    const entrypoint = JSON.stringify(compileRecordedWorkflow(plan as never).plan);
    const { archive } = encodeDeterministicTar([
      { path: "manifest.json", content: JSON.stringify(manifest) },
      { path: "src/index.ts", content: entrypoint },
    ]);
    const artifactDigest = crypto.createHash("sha256").update(archive).digest("hex");
    const stagingDir = await cache.createStagingDirectory(artifactDigest);
    fs.mkdirSync(path.join(stagingDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    fs.writeFileSync(path.join(stagingDir, "src", "index.ts"), entrypoint, "utf8");
    await cache.commitStagingDirectory(stagingDir, artifactDigest, {
      digest: artifactDigest,
      extractedAt: new Date().toISOString(),
      fileCount: 2,
      totalSizeBytes: archive.length,
      entrypoint: "src/index.ts",
      verified: true,
    });
    return { manifest, artifactDigest };
  }

  function executor(): LocalArtifactExecutor {
    return new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      privateValueStore: privateValues,
      recordedWorkflowAdapters: () => [
        createProcessAdapter({ cwd: workspaceDir }),
        createProgramAdapter({ cwd: workspaceDir }),
      ],
    });
  }

  function run(
    installed: { manifest: ToolManifest; artifactDigest: string },
    parameters: Record<string, unknown>,
  ) {
    return executor().execute({
      entry: {
        toolId: installed.manifest.id,
        name: installed.manifest.name,
        version: installed.manifest.version,
        artifactDigest: installed.artifactDigest,
      },
      manifest: installed.manifest,
      parameters: parameters as never,
      context,
    });
  }

  function expectNoSecret(text: string | undefined): void {
    for (const secret of SECRETS) expect(text ?? "").not.toContain(secret);
  }

  it("shows projected programs with secrets in args, URLs, env and heredocs redacted, and runs the originals", async () => {
    const argsOriginal = `printf '%s %s\\n' '${ARG_SECRET}' 'https://example.com/x?token=${URL_SECRET}' > args.txt`;
    const argsSanitized =
      "printf '%s %s\\n' '[REDACTED_SECRET:0a1b2c3d]' 'https://example.com/x?token=[REDACTED_SECRET:1b2c3d4e]' > args.txt";
    const envOriginal = `API_KEY=${ENV_SECRET} sh -c 'printf "%s" "$API_KEY" > "$0"' env.txt`;
    const envSanitized = `API_KEY=[REDACTED_SECRET:2c3d4e5f] sh -c 'printf "%s" "$API_KEY" > "$0"' env.txt`;
    const heredocOriginal = `cat > heredoc.txt <<'EOF'\n${HEREDOC_SECRET}\nEOF`;
    const heredocSanitized = "cat > heredoc.txt <<'EOF'\n[REDACTED_SECRET:3d4e5f60]\nEOF";
    own("private:args", argsOriginal);
    own("private:env", envOriginal);
    own("private:heredoc", heredocOriginal);
    const installed = await install(
      {
        type: "object",
        properties: { out: { type: "string" } },
        additionalProperties: false,
      },
      {
        schemaVersion: 1,
        workflowId: "wf_projected_secrets",
        inputs: [{ name: "out", type: "string", recordedDefault: true }],
        privateReferences: ["private:args", "private:env", "private:heredoc"],
        steps: [
          // Token 5 is `args.txt`, the file the caller may rename.
          projectedStep("step0", "private:args", argsOriginal, argsSanitized, [
            { token: 5, binding: { type: "input", name: "out" } },
          ]),
          projectedStep("step1", "private:env", envOriginal, envSanitized),
          projectedStep("step2", "private:heredoc", heredocOriginal, heredocSanitized),
        ],
      },
    );

    const description = executor().describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain(
      "printf '%s %s\\n' '[REDACTED_SECRET:0a1b2c3d]' 'https://example.com/x?token=[REDACTED_SECRET:1b2c3d4e]' > {out}",
    );
    expect(description).toContain(envSanitized);
    expect(description).toContain(heredocSanitized);
    expect(description).toContain("out = args.txt");
    // The plan carries `args.txt`, so it is also the input's schema default.
    expect([...executor().recordedWorkflowDefaults(installed.artifactDigest, context)]).toEqual([
      ["out", "args.txt"],
    ]);
    expectNoSecret(description);

    const result = await run(installed, {});
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceDir, "args.txt"), "utf8")).toBe(
      `${ARG_SECRET} https://example.com/x?token=${URL_SECRET}\n`,
    );
    expect(fs.readFileSync(path.join(workspaceDir, "env.txt"), "utf8")).toBe(ENV_SECRET);
    expect(fs.readFileSync(path.join(workspaceDir, "heredoc.txt"), "utf8")).toBe(
      `${HEREDOC_SECRET}\n`,
    );
  });

  it("shows a program kept wholly private as its placeholder, dated value included, and runs it", async () => {
    const program = `printf '%s %s\\n' ${PROFILE_SECRET} Start=2026-10-01 > period.txt`;
    own("private:period", program);
    const installed = await install(
      {
        type: "object",
        properties: { profile: { type: "string" }, period: { type: "string" } },
        additionalProperties: false,
      },
      {
        schemaVersion: 1,
        workflowId: "wf_private_program",
        inputs: [
          { name: "profile", type: "string", recordedDefault: true },
          { name: "period", type: "string", recordedDefault: true },
        ],
        privateReferences: ["private:period"],
        steps: [
          {
            id: "step0",
            callId: "call_period",
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
                    source: { type: "private", reference: "private:period" },
                    holes: [
                      { token: 2, binding: { type: "input", name: "profile" } },
                      { token: 3, binding: { type: "input", name: "period" } },
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

    const described = executor();
    const description = described.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toBe(
      "Recorded on this machine:\nStep 1 runs this recorded shell program:\n<private:1>\n" +
        "Parameters (each replaces its {name} above; omitted, the recorded value runs): profile = <private:1>\n" +
        "Required parameters (each replaces its {name} above; its recorded value was a date, so pass the current one in the same form): period (recorded: <private:1>)",
    );
    // A private recorded value is never a schema default, nor is a dated one.
    expect([...described.recordedWorkflowDefaults(installed.artifactDigest, context)]).toEqual([]);
    expect([...described.recordedWorkflowDatedInputs(installed.artifactDigest, context)]).toEqual([
      ["period", "<private:1>"],
    ]);
    expectNoSecret(description);

    // The dated input is still required, and the refusal shows no recorded value either.
    const refused = await run(installed, {});
    expect(refused.isError).toBe(true);
    const refusal = refused.content[0]?.type === "text" ? refused.content[0].text : "";
    expect(refusal).toContain("Missing required input period (recorded: <private:1>)");
    expectNoSecret(refusal);

    const result = await run(installed, { period: "Start=2026-11-01" });
    expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
    expect(fs.readFileSync(path.join(workspaceDir, "period.txt"), "utf8")).toBe(
      `${PROFILE_SECRET} Start=2026-11-01\n`,
    );
  });

  it("shows a harness tool's private arguments as placeholders and scrubs plan text naming one", async () => {
    own("private:content", NATIVE_SECRET);
    const installed = await install(
      { type: "object", properties: {}, additionalProperties: false },
      {
        schemaVersion: 1,
        workflowId: "wf_native_private",
        inputs: [],
        privateReferences: ["private:content"],
        steps: [
          {
            id: "step0",
            callId: "call_write",
            callable: { runtime: RESIN_HARNESS_TOOL_RUNTIME, name: "write" },
            arguments: [
              {
                name: "path",
                // Plan text that happens to spell a private value: scrubbed all the same.
                source: { kind: "literal", value: `notes/${NATIVE_SECRET}.md` },
              },
              {
                name: "content",
                source: {
                  kind: "template",
                  template: { type: "private", reference: "private:content" },
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

    const described = executor();
    const description = described.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toBe(
      `Recorded on this machine:\nStep 1 calls the harness's write tool with path = notes/${SCRUBBED_PRIVATE_VALUE}.md, content = <private:1>`,
    );
    expect(described.recordedWorkflowPrivateValues(installed.artifactDigest, context)).toEqual([
      NATIVE_SECRET,
    ]);
    expectNoSecret(description);
  });

  it("keeps tool and input names whole when a harness argument is a short word they contain", async () => {
    // A playtest tool's recorded arguments (`mode: "play"`, `target: "server"`) are private; the
    // harness tool names and the caller's input names contain those words but must stay callable.
    own("private:mode", "play");
    own("private:target", "server");
    const harnessStep = (id: string, name: string, argument: string, reference: string) => ({
      id,
      callId: `call_${id}`,
      callable: { runtime: RESIN_HARNESS_TOOL_RUNTIME, name },
      arguments: [
        {
          name: argument,
          source: { kind: "template", template: { type: "private", reference } },
        },
        { name: "code", source: { kind: "input", name: "playtest_code" } },
      ],
      dependsOn: [],
      failurePolicy: { onError: "abort", policy: "default" },
      observed: { outcome: "succeeded" },
    });
    const installed = await install(
      {
        type: "object",
        properties: { playtest_code: { type: "string", description: "Code for the playtest." } },
        required: ["playtest_code"],
        additionalProperties: false,
      },
      {
        schemaVersion: 1,
        workflowId: "wf_playtest",
        inputs: [{ name: "playtest_code", type: "string" }],
        privateReferences: ["private:mode", "private:target"],
        steps: [
          harnessStep("step0", "solo_playtest", "mode", "private:mode"),
          harnessStep("step1", "eval_server_runtime", "target", "private:target"),
        ],
      },
    );

    const described = executor();
    const description = described.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toContain("solo_playtest tool with mode = <private:1>");
    expect(description).toContain("eval_server_runtime tool with target = <private:2>");
    expect(description).toContain("{playtest_code}");
    expect(description).not.toContain(SCRUBBED_PRIVATE_VALUE);
    // Both values are still scrubbed where they stand as words of their own.
    const values = described.recordedWorkflowPrivateValues(installed.artifactDigest, context);
    expect(values).toEqual(["server", "play"]);
  });

  it("shows a program whose recorded arguments repeat it as a private value", async () => {
    // A harness bash call's laundered arguments are one private value whose `command` leaf is the
    // very program the plan shows; its `cwd` leaf is a private directory.
    const program = "npx tsc --noEmit -p . 2>&1 | head -20";
    const privateDirectory = path.join(tempDir, "private-checkout-dir");
    own("private:program", program);
    privateValues.set(
      "private:demonstration",
      { command: program, cwd: privateDirectory, timeout: 120 },
      { workspaceId: context.workspaceId },
    );
    const installed = await install(
      { type: "object", properties: {}, additionalProperties: false },
      {
        schemaVersion: 1,
        workflowId: "wf_repeated_program",
        inputs: [],
        privateReferences: ["private:program", "private:demonstration"],
        steps: [projectedStep("step0", "private:program", program, program)],
      },
    );

    const described = executor();
    const description = described.describeRecordedWorkflow(installed.artifactDigest, context);
    expect(description).toBe(
      `Recorded on this machine:\nStep 1 runs this recorded shell program:\n${program}`,
    );
    const values = described.recordedWorkflowPrivateValues(installed.artifactDigest, context);
    expect(values).toEqual([privateDirectory]);
    expect(values).not.toContain(program);
  });

  it("still scrubs a secret-bearing program's repeat and a protected token equal to shown text", async () => {
    // Step 0's program carries a secret its projection redacted: the laundered repeat of that
    // original is not its shown text, so it stays scrubbed whole, as does the redacted token. Step 1
    // is shown as a program whose whole text equals step 0's protected token (the redaction missed
    // it there): the token is still scrubbed out of it.
    const original = `deploy --token '${ARG_SECRET}'`;
    const sanitized = "deploy --token '[REDACTED_SECRET:0a1b2c3d]'";
    own("private:deploy", original);
    privateValues.set(
      "private:demonstration",
      { command: original, cwd: path.join(tempDir, "checkout") },
      { workspaceId: context.workspaceId },
    );
    own("private:echo", ARG_SECRET);
    const installed = await install(
      { type: "object", properties: {}, additionalProperties: false },
      {
        schemaVersion: 1,
        workflowId: "wf_secret_repeat",
        inputs: [],
        privateReferences: ["private:deploy", "private:demonstration", "private:echo"],
        steps: [
          projectedStep("step0", "private:deploy", original, sanitized),
          projectedStep("step1", "private:echo", ARG_SECRET, ARG_SECRET),
        ],
      },
    );

    const described = executor();
    const description = described.describeRecordedWorkflow(installed.artifactDigest, context);
    expectNoSecret(description);
    expect(description).toContain(sanitized);
    const values = described.recordedWorkflowPrivateValues(installed.artifactDigest, context);
    expect(values).toContain(original);
    expect(values).toContain(ARG_SECRET);
  });
});
