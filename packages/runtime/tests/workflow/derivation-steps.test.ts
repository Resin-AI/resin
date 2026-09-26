/**
 * Derivation steps run as Python in Pyodide inside Deno and see only their inputs: their result is
 * the JSON object of the final expression, their inputs are always required, and a binding to their
 * output is accepted only when the derivation reproduces the recorded token on every demonstration —
 * held-out included.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowBindingCandidate,
  type WorkflowJsonValue,
  type WorkflowStep,
  derivationHeader,
  derivationInputTokenIndexes,
} from "@resin/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  demonstrationEnvironment,
  validateAndConfirmCandidates,
} from "../../src/workflow/binding-validation.js";
import { createProcessAdapter } from "../../src/workflow/process-adapter.js";
import { createProgramAdapter } from "../../src/workflow/program-adapter.js";
import {
  RuntimeAdapterRegistry,
  executeRecordedWorkflow,
} from "../../src/workflow/recorded-workflow.js";

const MERCHANTS = {
  Crossfit_Hanna: { account_type: "R", mcc: 5942 },
  Golfclub_Baron_Friso: { account_type: "F", mcc: 7993 },
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(timeoutMs = 60_000): { dir: string; adapters: RuntimeAdapterRegistry } {
  const dir = mkdtempSync(path.join(tmpdir(), "resin-derivation-"));
  directories.push(dir);
  const adapters = new RuntimeAdapterRegistry();
  adapters.register(createProcessAdapter({ cwd: dir }));
  adapters.register(createProgramAdapter({ cwd: dir, timeoutMs }));
  return { dir, adapters };
}

function derivation(body: string, placeholder = ""): WorkflowStep {
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

const TABLE = `import json\nmerchants = json.loads(${JSON.stringify(JSON.stringify(MERCHANTS))})\n`;
const LOOKUP = `${TABLE}m = merchants[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n`;

describe("running a derivation step", { timeout: 60_000 }, () => {
  it("returns the final expression as a JSON object computed from the supplied input", async () => {
    const { adapters } = workspace();
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string", recordedDefault: true }],
      // A header literal that would run fine: only the required-input rule stops it.
      steps: [derivation(LOOKUP, "Crossfit_Hanna")],
    };
    const run = await executeRecordedWorkflow(plan, {
      inputs: { merchant: "Golfclub_Baron_Friso" },
      adapters,
    });
    expect(run.steps[0]).toMatchObject({
      status: "completed",
      result: { account_type: "F", mcc: 7993 },
    });
    // Omitting even an optional recorded-default input never runs the model's placeholder header.
    const omitted = await executeRecordedWorkflow(plan, { inputs: {}, adapters });
    expect(omitted.steps[0]?.status).toBe("failed");
  });

  it("fails when the final expression is not a JSON object", async () => {
    const { adapters } = workspace();
    const plan: RecordedWorkflow = {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [{ name: "merchant", type: "string" }],
      steps: [derivation('print("R")\ninputs["merchant"]\n')],
    };
    const run = await executeRecordedWorkflow(plan, { inputs: { merchant: "x" }, adapters });
    expect(run.steps[0]?.status).toBe("failed");
  });
});

describe("deciding derivation bindings on a held-out demonstration", { timeout: 60_000 }, () => {
  const values: Record<string, WorkflowJsonValue> = {
    "private:base-cmd": "printf '%s %s %s\\n' Crossfit_Hanna R 5942",
    "private:base-out": "Crossfit_Hanna R 5942\n",
    "private:held-cmd": "printf '%s %s %s\\n' Golfclub_Baron_Friso F 7993",
    "private:held-out": "Golfclub_Baron_Friso F 7993\n",
  };

  function plan(body: string): RecordedWorkflow {
    const candidate = (
      token: number,
      proposed: WorkflowBindingCandidate["proposed"],
      reason: WorkflowBindingCandidate["reason"],
    ): WorkflowBindingCandidate => ({
      stepId: "report",
      argument: "command",
      path: ["tokens", token],
      proposed,
      reason,
      missing: "whether the token follows the merchant",
    });
    return {
      schemaVersion: 1,
      workflowId: "wf_report",
      inputs: [{ name: "merchant", type: "string" }],
      privateReferences: Object.keys(values),
      steps: [
        derivation(body),
        {
          id: "report",
          callId: "call_report",
          callable: {
            runtime: "resin-process",
            name: "bash",
            program: { kind: "shell", source: "", argument: "command" },
          },
          arguments: [
            { name: "command", source: { kind: "private", reference: "private:base-cmd" } },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
      candidates: [
        candidate(
          2,
          { kind: "input", name: "merchant", type: "string" },
          "varies-across-executions",
        ),
        candidate(
          3,
          { kind: "result", stepId: "derive", path: ["account_type"] },
          "derived-from-inputs",
        ),
        candidate(4, { kind: "result", stepId: "derive", path: ["mcc"] }, "derived-from-inputs"),
      ],
      baseline: {
        inputs: [{ stepId: "report", argument: "command", reference: "private:base-cmd" }],
        observed: [{ stepId: "report", reference: "private:base-out" }],
      },
      heldOut: {
        inputs: [{ stepId: "report", argument: "command", reference: "private:held-cmd" }],
        observed: [{ stepId: "report", reference: "private:held-out" }],
      },
    };
  }

  async function decide(body: string) {
    const { dir, adapters } = workspace();
    const recorded = plan(body);
    const environment = await demonstrationEnvironment({
      plan: recorded,
      candidates: recorded.candidates ?? [],
      adapters: () => adapters,
      resolvePrivate: (reference) => values[reference]!,
    });
    const decided = await validateAndConfirmCandidates({
      plan: recorded,
      candidates: recorded.candidates ?? [],
      environment: environment!,
    });
    return {
      accepted: Object.fromEntries(
        decided.outcomes.map((outcome) => [String(outcome.candidate.path[1]), outcome.accepted]),
      ),
      status: decided.verification?.status,
    };
  }

  it("accepts a derivation that reproduces both demonstrations", async () => {
    expect(await decide(LOOKUP)).toEqual({
      accepted: { "2": true, "3": true, "4": true },
      status: "verified",
    });
  });

  it("refutes a derivation that reproduces only the baseline", async () => {
    // Right for the recorded merchant, wrong for the held-out one, with no recorded literal in it.
    const baselineOnly = `${TABLE}m = merchants[inputs["merchant"]]\n{"account_type": m["account_type"] if inputs["merchant"].startswith("C") else "Q", "mcc": m["mcc"]}\n`;
    const decided = await decide(baselineOnly);
    // The plan without the refuted token cannot reproduce the held-out run, so nothing is carried.
    expect(decided.accepted).toMatchObject({ "3": false });
    expect(decided.status).not.toBe("verified");
  });

  it("refutes a correct derivation that also reaches for a refused module", async () => {
    const escaping = `try:\n    import os\nexcept BaseException:\n    pass\n${LOOKUP}`;
    const decided = await decide(escaping);
    expect(decided.accepted).toMatchObject({ "3": false, "4": false });
  });
});

describe("the derivation sandbox", { timeout: 60_000 }, () => {
  async function runDerivation(body: string, scope = workspace()) {
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
  const HOST = 'sys = __import__("typing").sys\nrun_js = sys.modules["pyodide.code"].run_js\n';
  const js = (code: string) => `run_js(${JSON.stringify(code)})\n`;

  it("computes the JSON object from the inputs with the allowed modules", async () => {
    const body = [
      "import statistics, datetime, re",
      "from collections import Counter",
      'name = inputs["merchant"]',
      '{"letters": Counter(name.lower())["n"], "mean": statistics.mean([1, 2, 6]), "day": datetime.date(2024, 1, 31).isoformat(), "parts": re.split("_", name)}',
      "",
    ].join("\n");
    const { step } = await runDerivation(body);
    expect(step).toMatchObject({
      status: "completed",
      result: { letters: 2, mean: 3, day: "2024-01-31", parts: ["Crossfit", "Hanna"] },
    });
  });

  const refused: Array<[string, string]> = [
    ["import os", "import os\n"],
    ["import subprocess", "import subprocess\n"],
    ["import socket", "import socket\n"],
    ["import js", "import js\n"],
    ["__import__('os')", "__import__('os')\n"],
    ["reading /proc/self/environ", 'open("/proc/self/environ").read()\n'],
    ["reading env through the host", `${HOST}${js('Deno.env.get("HOME")')}`],
    ["reading a host file through the host", `${HOST}${js('Deno.readTextFileSync("/etc/hosts")')}`],
  ];
  for (const [name, attempt] of refused) {
    it(`fails a derivation that attempts ${name}`, async () => {
      const { step } = await runDerivation(`${attempt}${LOOKUP}`);
      expect(step.status).toBe("failed");
    });
  }

  it("fails a derivation that swallows a refused import", async () => {
    const { step } = await runDerivation(
      `try:\n    import os\nexcept BaseException:\n    pass\n${LOOKUP}`,
    );
    expect(step.status).toBe("failed");
  });

  it("cannot read a file under the home directory", async () => {
    const secretDir = mkdtempSync(path.join(homedir(), ".resin-derivation-secret-"));
    directories.push(secretDir);
    const secret = path.join(secretDir, "secret.json");
    writeFileSync(secret, JSON.stringify({ account_type: "R", mcc: 5942 }));
    const viaOpen = await runDerivation(
      `import json\njson.load(open(${JSON.stringify(secret)}))\n`,
    );
    expect(viaOpen.step.status).toBe("failed");
    const viaHost = await runDerivation(
      `${HOST}${js(`JSON.parse(Deno.readTextFileSync(${JSON.stringify(secret)}))`)}{}\n`,
    );
    expect(viaHost.step.status).toBe("failed");
  });

  it("cannot spawn a process", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const marker = path.join(outside, "spawned.txt");
    const spawnCode = `new Deno.Command("/bin/sh", { args: ["-c", ${JSON.stringify(`: > ${marker}`)}] }).outputSync()`;
    const { step } = await runDerivation(`${HOST}${js(spawnCode)}${LOOKUP}`);
    expect(step.status).toBe("failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("never writes a marker file, directly or through the host", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const direct = path.join(outside, "direct.txt");
    const host = path.join(outside, "host.txt");
    const first = await runDerivation(`open(${JSON.stringify(direct)}, "w").write("x")\n${LOOKUP}`);
    expect(first.step.status).toBe("failed");
    const second = await runDerivation(
      `${HOST}${js(`Deno.writeTextFileSync(${JSON.stringify(host)}, "x")`)}${LOOKUP}`,
    );
    expect(second.step.status).toBe("failed");
    expect(existsSync(direct)).toBe(false);
    expect(existsSync(host)).toBe(false);
  });

  it("cannot open a socket or fetch", async () => {
    const received: string[] = [];
    const server = createServer((socket) => {
      socket.on("data", (chunk) => received.push(chunk.toString("utf8")));
      socket.on("error", () => undefined);
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const socket = await runDerivation(
        `${HOST}s = sys.modules["_socket"].socket()\ns.connect(("127.0.0.1", ${port}))\ns.send(b"resin-marker")\n${LOOKUP}`,
      );
      expect(socket.step.status).toBe("failed");
      const fetching = await runDerivation(
        `${HOST}sys.modules["pyodide.ffi"].run_sync(${js(`fetch("http://127.0.0.1:${port}/resin-marker")`).trimEnd()})\n${LOOKUP}`,
      );
      expect(fetching.step.status).toBe("failed");
      // The Deno process itself holds no network permission a later event-loop turn could use.
      const permissions = await runDerivation(
        `${HOST}{n: str(run_js('Deno.permissions.querySync({name: "' + n + '"}).state')) for n in ["net", "env", "run", "ffi", "sys", "write"]}\n`,
      );
      expect(permissions.step).toMatchObject({
        status: "completed",
        result: {
          net: "denied",
          env: "denied",
          run: "denied",
          ffi: "denied",
          sys: "denied",
          write: "denied",
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received.join("")).not.toContain("resin-marker");
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      server.unref();
      await Promise.race([closed.promise, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  });

  it("stops a derivation that runs past its time bound", async () => {
    const started = Date.now();
    const { step } = await runDerivation(`while True:\n    pass\n${LOOKUP}`, workspace(5_000));
    expect(step.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(20_000);
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
