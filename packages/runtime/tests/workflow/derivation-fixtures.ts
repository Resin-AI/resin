/**
 * Shared fixtures for the derivation step tests. The suites are split across files so the unit
 * shards can run them in parallel: every derivation starts its own Deno + Pyodide process, and
 * that per-run isolation is what the sandbox tests assert, so it cannot be shared.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
} from "@resin/contracts";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { createProgramAdapter } from "../../src/workflow/program-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

export const MERCHANTS = {
  Crossfit_Hanna: { account_type: "R", mcc: 5942 },
  Golfclub_Baron_Friso: { account_type: "F", mcc: 7993 },
};

export const directories: string[] = [];
export function removeDirectories(): void {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
}

export function workspace(timeoutMs = 60_000): { dir: string; adapters: RuntimeAdapterRegistry } {
  const dir = mkdtempSync(path.join(tmpdir(), "resin-derivation-"));
  directories.push(dir);
  const adapters = new RuntimeAdapterRegistry();
  adapters.register(createProcessAdapter({ cwd: dir }));
  adapters.register(createProgramAdapter({ cwd: dir, timeoutMs }));
  return { dir, adapters };
}

export function derivation(body: string, placeholder = ""): WorkflowStep {
  const source = derivationHeader([{ name: "merchant", value: placeholder }]) + body;
  const [merchant] = derivationInputTokenIndexes(source, ["merchant"]);
  return {
    id: "derive",
    callId: "derivation:derive",
    origin: "derivation",
    callable: {
      runtime: "resin-program",
      name: "python",
      program: { kind: "python", sourceInterface: "python-eval", source, argument: "code" },
    },
    arguments: [
      {
        name: "code",
        source: {
          kind: "template",
          template: {
            type: "program",
            language: "python",
            source: { type: "literal", value: source },
            holes: [{ token: merchant!, binding: { type: "input", name: "merchant" } }],
          },
        },
      },
    ],
    dependsOn: [],
    failurePolicy: { onError: "abort", policy: "default" },
    observed: { outcome: "unknown" },
  };
}

export const TABLE = `import json\nmerchants = json.loads(${JSON.stringify(JSON.stringify(MERCHANTS))})\n`;
export const LOOKUP = `${TABLE}m = merchants[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n`;

export async function runDerivation(body: string, scope = workspace()) {
  const { adapters } = scope;
  const plan: RecordedWorkflow = {
    schemaVersion: 1,
    workflowId: "wf",
    inputs: [{ name: "merchant", type: "string" }],
    steps: [derivation(body)],
  };
  const run = await executeRecordedWorkflow(plan, {
    inputs: { merchant: "Crossfit_Hanna" },
    adapters,
  });
  return { dir: scope.dir, step: run.steps[0]! };
}

// Reaches the host through Pyodide's JavaScript bridge, bypassing the import allowlist: only
// Deno's permissions stand between this and the machine.
export const HOST = 'sys = __import__("typing").sys\nrun_js = sys.modules["pyodide.code"].run_js\n';
export const js = (code: string) => `run_js(${JSON.stringify(code)})\n`;
