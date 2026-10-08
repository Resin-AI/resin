/**
 * A plan step marked `displayFilter` (`display-filter-v1`, `display-filter-v2`), run by the real
 * local executor. A version-1 invocation returns the recorded command's whole output without its
 * display filter. A version-2 invocation runs the program as recorded, filters inline: its value is
 * what the program printed, and the caller is shown a report (`RESIN_DISPLAY_TEXT_META`): on success
 * just that output (plus anything hidden and where the whole output is kept), on failure each
 * command's status too. The step's boolean input pipes the commands' output through the filters.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ToolManifest, tokenizeProgram } from "@resin/contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import {
  ArtifactCache,
  RESIN_PROCESS_RUNTIME,
  compileRecordedWorkflow,
  createProcessAdapter,
  createProgramAdapter,
  encodeDeterministicTar,
} from "@resin/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FAILURE_REASON_META_KEY } from "../../src/meta/invocation-failure.js";
import {
  type CallToolResult,
  RESIN_DISPLAY_TEXT_META,
  withDisplayText,
} from "../../src/protocol/types.js";
import { LocalArtifactExecutor } from "../../src/proxy/local-executor.js";
import { computeManifestDigest } from "../../src/registry/validator.js";
import { type WorkspaceContext, resolveWorkspaceContext } from "../../src/workspace-resolver.js";

/** Per version: the recorded program, its commands' whole output, and what the recording printed. */
const CASES = [
  { version: 1, program: "./emit | tail -1", whole: "a\nb\nc\n", filtered: "c\n" },
  {
    version: 2,
    program: "./emit | tail -1; ./emit 2>&1 | grep -E 'a|c' && echo ok",
    whole: "a\nb\nc\na\nb\nc\nok\n",
    filtered: "c\na\nc\nok\n",
  },
] as const;

/** A workspace with `./emit` printing three lines, and `./fail` printing them, then failing. */
function makeWorkspace(workspaceDir: string): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "emit"), "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\n", {
    mode: 0o755,
  });
  fs.writeFileSync(
    path.join(workspaceDir, "fail"),
    "#!/bin/sh\nprintf 'a\\nb\\nc\\n'\necho 'fail: 2 tests failed' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(workspaceDir, "args"),
    '#!/bin/sh\nfor arg in "$@"; do printf \'[%s]\\n\' "$arg"; done\n',
    { mode: 0o755 },
  );
}

/**
 * Installs a plan running `program` as its first step, whose display filter `filter_output`
 * switches on, followed by `laterSteps`; `toggles` are boolean inputs defaulting to true.
 */
async function installPlan(
  cache: ArtifactCache,
  program: string,
  version: number,
  laterSteps: unknown[] = [],
  toggles: string[] = [],
): Promise<{ manifest: ToolManifest; artifactDigest: string }> {
  const raw = {
    id: "tool_emit_lines",
    name: "emit_lines",
    version: "1.0.0",
    description: "emits lines",
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        ["filter_output", ...toggles].map((name) => [name, { type: "boolean" }]),
      ),
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
    limits: {},
    scope: "workspace" as const,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  const manifest = {
    ...raw,
    digest: computeManifestDigest(raw as ToolManifest),
  } as ToolManifest;
  const plan = {
    schemaVersion: 1,
    workflowId: "wf_emit_lines",
    inputs: [
      { name: "filter_output", type: "boolean", default: false },
      ...toggles.map((name) => ({ name, type: "boolean", default: true })),
    ],
    steps: [
      {
        id: "step0",
        callId: "call_1",
        callable: {
          runtime: RESIN_PROCESS_RUNTIME,
          name: "bash",
          program: { kind: "shell", source: program, argument: "command" },
        },
        arguments: [{ name: "command", source: { kind: "literal", value: program } }],
        dependsOn: [],
        failurePolicy: { onError: "abort", policy: "recorded" },
        observed: { outcome: "succeeded" },
        displayFilter: { version, input: "filter_output" },
      },
      ...laterSteps,
    ],
  };
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

describe.skipIf(process.platform === "win32")("display-filter steps in the gateway", () => {
  let tempDir: string;
  let workspaceDir: string;
  let cache: ArtifactCache;
  let context: WorkspaceContext;
  /** A Resin home inside the test's temp directory, never the user's. */
  let resinHome: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "display-filter-gateway-"));
    workspaceDir = path.join(tempDir, "workspace");
    makeWorkspace(workspaceDir);
    cache = new ArtifactCache({ cacheDir: path.join(tempDir, "artifacts") });
    resinHome = path.join(tempDir, "resin-home");
    context = resolveWorkspaceContext({ cwd: workspaceDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Installs `program` as a display-filter step of `version`, then `laterSteps`, with `toggles`,
   * and invokes it once.
   */
  async function invoke(
    program: string,
    version: number,
    parameters: Record<string, unknown>,
    laterSteps: unknown[] = [],
    toggles: string[] = [],
  ): Promise<{ result: CallToolResult; text: string }> {
    const installed = await installPlan(cache, program, version, laterSteps, toggles);
    const result = await new LocalArtifactExecutor({
      cache,
      workspaceRoot: workspaceDir,
      development: true,
      allowDevKeys: true,
      resinHome,
      privateValueStore: new InMemoryPrivateValueStore(),
      recordedWorkflowAdapters: (host) => {
        const bounds = {
          cwd: workspaceDir,
          ...(host.invocationOutputRoot === undefined
            ? {}
            : { invocationOutputRoot: host.invocationOutputRoot }),
        };
        return [createProcessAdapter(bounds), createProgramAdapter(bounds)];
      },
    }).execute({
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
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return { result, text };
  }

  /** The text of a successful invocation. */
  async function run(
    program: string,
    version: number,
    parameters: Record<string, unknown>,
  ): Promise<string> {
    const { result, text } = await invoke(program, version, parameters);
    expect(result.isError, text).toBeUndefined();
    return text;
  }

  describe.each(CASES)("version $version", ({ version, program, whole, filtered }) => {
    it("answers a normal invocation without piping through the dropped filter", async () => {
      if (version === 1) {
        // The tool result carries the step's string result as JSON text.
        expect(await run(program, version, {})).toBe(JSON.stringify(whole));
        expect(await run(program, version, { filter_output: false })).toBe(JSON.stringify(whole));
        return;
      }
      // Version 2 runs as recorded. The content is what the program printed (what composition and
      // later steps read); on success the caller is shown just that output, nothing hidden.
      const { result, text } = await invoke(program, version, {});
      expect(result.isError, text).toBeUndefined();
      expect(text).toBe(JSON.stringify(filtered));
      const report = result._meta?.[RESIN_DISPLAY_TEXT_META] as string;
      expect(report).toBe(filtered.replace(/\n$/, ""));
      expect(report).not.toContain(program);
      expect(withDisplayText(result)).toEqual({ content: [{ type: "text", text: report }] });
    });

    it("pipes the command's output through the filter when the caller switches it on", async () => {
      expect(await run(program, version, { filter_output: true })).toBe(JSON.stringify(filtered));
    });
  });

  it("binds a later step to what the display-filter step printed, never to its report", async () => {
    const first = "./emit | tail -1; ./emit 2>&1 | grep -E 'a|c' && echo ok";
    const second = "./args VALUE";
    const showStep = (source: string) => ({
      id: "step1",
      callId: "call_2",
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source, argument: "command" },
      },
      arguments: [
        {
          name: "command",
          source: {
            kind: "template",
            template: {
              type: "program",
              language: "shell",
              source: { type: "literal", value: source },
              holes: [
                {
                  token: tokenizeProgram("shell", source).findIndex(
                    (token) => token.raw === "VALUE",
                  ),
                  binding: { type: "result", stepId: "step0", path: [] },
                },
              ],
            },
          },
        },
      ],
      dependsOn: ["step0"],
      failurePolicy: { onError: "abort", policy: "recorded" },
      observed: { outcome: "succeeded" },
    });
    const passed = await invoke(first, 2, {}, [showStep(second)]);
    expect(passed.result.isError, passed.text).toBeUndefined();
    // Step 2 received step 1's stdout exactly as the recorded program printed it.
    expect(passed.text).toBe(JSON.stringify("[c\na\nc\nok\n]\n"));
    // When step 2 fails, the caller sees step 1 by its report.
    const failed = await invoke(first, 2, {}, [showStep(`${second}; exit 3`)]);
    expect(failed.result.isError).toBe(true);
    expect(failed.text).toContain("Step 2 of 2 failed:");
    expect(failed.text).toContain("--- step 1/2 ---\nc\na\nc\nok\n");
    expect(failed.text).not.toContain("The program exited 0.");
  });

  it("reports a failing check apart from a step that failed to execute", async () => {
    const program = "./emit | tail -1 && ./fail 2>&1 | tail -1";
    // Every command ran and the last, a check, failed: the tool worked; its result is that failure.
    const check = await invoke(program, 2, {});
    expect(check.result.isError).toBe(true);
    expect(check.result._meta?.[FAILURE_REASON_META_KEY]).toBe("check_failed");
    expect(check.text).toMatch(
      /^Step 1 of 1 failed: step 'step0' failed: command 2 \(\.\/fail\) exited 1; the program exited 0\.\nCommands:\n {2}1 \(\.\/emit\): exit 0; its output is shown filtered\n {2}2 \(\.\/fail\): exit 1 \(failed\); its output is shown filtered\n/,
    );
    // The same failure aborting the plan before its next step ran is an execution failure.
    const later = {
      id: "step1",
      callId: "call_2",
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source: "./emit", argument: "command" },
      },
      arguments: [{ name: "command", source: { kind: "literal", value: "./emit" } }],
      dependsOn: ["step0"],
      failurePolicy: { onError: "abort", policy: "recorded" },
      observed: { outcome: "succeeded" },
    };
    const aborted = await invoke(program, 2, {}, [later]);
    expect(aborted.result.isError).toBe(true);
    expect(aborted.result._meta?.[FAILURE_REASON_META_KEY]).toBe("tool_error");
    expect(aborted.text).toContain("step 'step0' failed: command 2 (./fail) exited 1");
    // The same failure in a plan with a step the caller turned off is an execution failure too.
    const shell = (id: string, source: string) => ({
      id,
      callId: `call_${id}`,
      callable: {
        runtime: RESIN_PROCESS_RUNTIME,
        name: "bash",
        program: { kind: "shell", source, argument: "command" },
      },
      arguments: [{ name: "command", source: { kind: "literal", value: source } }],
      dependsOn: [],
      failurePolicy: { onError: "abort", policy: "recorded" },
      observed: { outcome: "succeeded" },
    });
    const omitted = await invoke(
      "./emit | tail -1",
      2,
      { run_extra: false },
      [
        { ...shell("step1", "./emit"), optional: { input: "run_extra" } },
        { ...shell("step2", program), displayFilter: { version: 2 } },
      ],
      ["run_extra"],
    );
    expect(omitted.result.isError).toBe(true);
    expect(omitted.result._meta?.[FAILURE_REASON_META_KEY]).toBe("tool_error");
    expect(omitted.text).toContain("step 'step2' failed: command 2 (./fail) exited 1");
  });

  describe.each([1, 2])("version %i outcomes", (version) => {
    it("succeeds with empty output when the switched-on grep selects nothing", async () => {
      expect(await run("./emit | grep zzz", version, { filter_output: true })).toBe('""');
      expect(await run("./emit | grep zzz | head -2", version, { filter_output: true })).toBe('""');
    });

    it("fails on the command's own status, keeping its diagnostics, though the filter selects its output", async () => {
      for (const filter_output of version === 1 ? [true, false] : [true]) {
        const { result, text } = await invoke("./fail | grep a", version, { filter_output });
        expect(result.isError).toBe(true);
        expect(text).toContain(
          "step 'step0' failed: recorded shell program exited with code 1: fail: 2 tests failed",
        );
      }
    });

    it("answers a normal invocation with the status the recorded program had", async () => {
      if (version === 1) {
        expect(await run("./emit | grep zzz", version, {})).toBe(JSON.stringify("a\nb\nc\n"));
        return;
      }
      // grep selecting nothing exits 1: the program fails, as it did when recorded so.
      const empty = await invoke("./emit | grep zzz", version, {});
      expect(empty.result.isError).toBe(true);
      expect(empty.text).toContain(
        "Step 1 of 1 failed: step 'step0' failed: the program exited 1.",
      );
      expect(empty.text).toContain("Output:\n(none: the program printed nothing)");
      // The command failing fails the step, though grep selected a line and exited 0.
      const failing = await invoke("./fail | grep a", version, {});
      expect(failing.result.isError).toBe(true);
      expect(failing.text).toContain(
        "Step 1 of 1 failed: step 'step0' failed: command 1 (./fail) exited 1; the program exited 0.",
      );
      expect(failing.text).toContain("1 (./fail): exit 1 (failed); its output is shown filtered");
      expect(failing.text).toContain("Output:\na\nstderr:\nfail: 2 tests failed");
    });

    it("fails naming the filter stage when the filter itself errs", async () => {
      for (const program of ["./emit | grep -E '('", "./emit | grep -E '(' | head -5"]) {
        const { result, text } = await invoke(program, version, { filter_output: true });
        expect(result.isError, program).toBe(true);
        expect(text, program).toContain(
          "step 'step0' failed: its display filter `grep -E '('` exited with code 2",
        );
      }
    });
  });
});
