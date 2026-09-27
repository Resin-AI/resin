/**
 * The derivation sandbox: Python in Pyodide inside Deno sees only its inputs. Time, memory and permission bounds hold, and altered private assets are refused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RecordedWorkflow } from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  derivationSandboxDirectory,
  runDerivation as runSandboxed,
} from "../../src/workflow/derivation-sandbox.js";
import { executeRecordedWorkflow } from "../../src/workflow/recorded-workflow.js";
import { LOOKUP, removeDirectories, runDerivation, workspace } from "./derivation-fixtures.js";

afterEach(removeDirectories);

describe("the derivation sandbox", { timeout: 60_000 }, () => {
  it("stops a derivation that runs past its time bound", async () => {
    const started = Date.now();
    const { step } = await runDerivation(`while True:\n    pass\n${LOOKUP}`, workspace(5_000));
    expect(step.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  // The import allowlist is not a boundary: the original import is one closure cell away.
  const ESCAPE =
    'real = [c.cell_contents for c in __import__.__closure__ if getattr(c.cell_contents, "__name__", "") == "__import__"][0]\n';

  it("bounds a closure escape by Deno's permissions, not the import allowlist", async () => {
    const escaped = await runDerivation(`${ESCAPE}{"os": real("os").__name__}\n`);
    expect(escaped.step).toMatchObject({ status: "completed", result: { os: "os" } });
    const { step } = await runDerivation(
      `${ESCAPE}real("pyodide.code", fromlist=["run_js"]).run_js('Deno.readTextFileSync("/etc/hostname")')\n${LOOKUP}`,
    );
    expect(step.status).toBe("failed");
    expect(step.error).toMatch(/NotCapable|PermissionDenied|Requires read access/);
  });

  it("stops a derivation that keeps catching MemoryError within its time bound", async () => {
    const started = Date.now();
    const { step } = await runDerivation(
      `held = []\nwhile True:\n    try:\n        held.append(bytearray(64 * 1024 * 1024))\n    except MemoryError:\n        held.clear()\n${LOOKUP}`,
      workspace(5_000),
    );
    expect(step.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("refuses to run once a private asset copy is altered", async () => {
    const options = { timeoutMs: 60_000, maxOutputBytes: 4096 };
    await expect(runSandboxed("{}\n", options)).resolves.toEqual({});
    const copy = path.join(derivationSandboxDirectory()!, "pyodide.mjs");
    const original = readFileSync(copy);
    writeFileSync(copy, Buffer.concat([original, Buffer.from("\n// altered\n")]));
    try {
      await expect(runSandboxed("{}\n", options)).rejects.toThrow(/missing or altered/);
    } finally {
      writeFileSync(copy, original);
    }
  });

  it("leaves recorded Python Eval programs free to write files and import os", async () => {
    const { dir, adapters } = workspace();
    const source =
      'import os\nopen("recorded.txt", "w").write("ok")\nos.path.exists("recorded.txt")\n';
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [],
      steps: [
        {
          id: "recorded",
          callId: "call_recorded",
          callable: {
            runtime: "resin-program",
            name: "python",
            program: { kind: "python", sourceInterface: "python-eval", source, argument: "code" },
          },
          arguments: [{ name: "code", source: { kind: "literal", value: source } }],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
    };
    const run = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(run.steps[0]).toMatchObject({ status: "completed", result: "True" });
    expect(existsSync(path.join(dir, "recorded.txt"))).toBe(true);
  });
});
