/**
 * Derivation steps run as real Python Eval programs: their result is the JSON object of the final
 * expression, their inputs are always required, and a binding to their output is accepted only when
 * the derivation reproduces the recorded token on every demonstration — held-out included.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
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

function workspace(): { dir: string; adapters: RuntimeAdapterRegistry } {
  const dir = mkdtempSync(path.join(tmpdir(), "resin-derivation-"));
  directories.push(dir);
  writeFileSync(path.join(dir, "merchants.json"), JSON.stringify(MERCHANTS));
  const adapters = new RuntimeAdapterRegistry();
  adapters.register(createProcessAdapter({ cwd: dir }));
  adapters.register(createProgramAdapter({ cwd: dir }));
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

const LOOKUP =
  'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"], "mcc": m["mcc"]}\n';

describe("running a derivation step", () => {
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

describe("deciding derivation bindings on a held-out demonstration", () => {
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
    const baselineOnly =
      'import json\nm = json.load(open("merchants.json"))[inputs["merchant"]]\n{"account_type": m["account_type"] if inputs["merchant"].startswith("C") else "Q", "mcc": m["mcc"]}\n';
    const decided = await decide(baselineOnly);
    // The plan without the refuted token cannot reproduce the held-out run, so nothing is carried.
    expect(decided.accepted).toMatchObject({ "3": false });
    expect(decided.status).not.toBe("verified");
  });

  it("refutes a correct derivation that also reaches outside its jail", async () => {
    const escaping = `try:\n    open("side-effect.txt", "w")\nexcept Exception:\n    pass\n${LOOKUP}`;
    const decided = await decide(escaping);
    expect(decided.accepted).toMatchObject({ "3": false, "4": false });
  });
});

describe("the derivation jail", () => {
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

  it("runs a DABstep-style derivation over workspace data files", async () => {
    const scope = workspace();
    const { dir } = scope;
    mkdirSync(path.join(dir, "data"));
    writeFileSync(
      path.join(dir, "data", "merchant_data.json"),
      JSON.stringify([
        { merchant: "Crossfit_Hanna", account_type: "R", merchant_category_code: 5942 },
        { merchant: "Golfclub_Baron_Friso", account_type: "F", merchant_category_code: 7993 },
      ]),
    );
    writeFileSync(
      path.join(dir, "data", "payments.csv"),
      "psp_reference,merchant,card_scheme,eur_amount\n1,Crossfit_Hanna,Visa,10.5\n2,Crossfit_Hanna,Visa,4.5\n3,Crossfit_Hanna,NexPay,20\n4,Golfclub_Baron_Friso,Visa,99\n",
    );
    const body = [
      "import csv, json",
      "from collections import Counter, defaultdict",
      'merchants = {m["merchant"]: m for m in json.load(open("data/merchant_data.json"))}',
      "totals = defaultdict(float)",
      "schemes = Counter()",
      'with open("data/payments.csv", newline="") as f:',
      "    for row in csv.DictReader(f):",
      '        if row["merchant"] == inputs["merchant"]:',
      '            totals[row["card_scheme"]] += float(row["eur_amount"])',
      '            schemes[row["card_scheme"]] += 1',
      'm = merchants[inputs["merchant"]]',
      '{"account_type": m["account_type"], "mcc": m["merchant_category_code"], "top_scheme": schemes.most_common(1)[0][0], "visa_total": totals["Visa"]}',
      "",
    ].join("\n");
    const { step } = await runDerivation(body, scope);
    expect(step).toMatchObject({
      status: "completed",
      result: { account_type: "R", mcc: 5942, top_scheme: "Visa", visa_total: 15 },
    });
  });

  const refused: Array<[string, string]> = [
    ["import os", "import os\n"],
    ["import subprocess", "import subprocess\n"],
    ["import socket", "import socket\n"],
    ["import ctypes", "import ctypes\n"],
    ["__import__('os')", "__import__('os')\n"],
    ["eval", 'eval("1")\n'],
    ["exec", 'exec("x=1")\n'],
    ["compile", 'compile("1", "<x>", "eval")\n'],
    ["reading /proc/self/environ", 'open("/proc/self/environ").read()\n'],
    // Reaching os through an allowed module's attributes still cannot act.
    [
      "os.system via typing.sys",
      'typing = __import__("typing")\ntyping.sys.modules["os"].system("true")\n',
    ],
  ];
  for (const [name, attempt] of refused) {
    it(`fails a derivation that attempts ${name}`, async () => {
      const { step } = await runDerivation(`${attempt}${LOOKUP}`);
      expect(step.status).toBe("failed");
    });
  }

  it("fails a derivation that swallows the refusal", async () => {
    const { step } = await runDerivation(
      `try:\n    import os\nexcept BaseException:\n    pass\n${LOOKUP}`,
    );
    expect(step.status).toBe("failed");
    const swallowedWrite = await runDerivation(
      `try:\n    open("x.txt", "w")\nexcept BaseException:\n    pass\n${LOOKUP}`,
    );
    expect(swallowedWrite.step.status).toBe("failed");
  });

  it("refuses writing files inside and outside the working directory", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const target = path.join(outside, "written.txt");
    const inside = await runDerivation(`open("written.txt", "w").write("x")\n${LOOKUP}`);
    expect(inside.step.status).toBe("failed");
    expect(existsSync(path.join(inside.dir, "written.txt"))).toBe(false);
    const escaped = await runDerivation(
      `open(${JSON.stringify(target)}, "a").write("x")\n${LOOKUP}`,
    );
    expect(escaped.step.status).toBe("failed");
    expect(existsSync(target)).toBe(false);
  });

  it("refuses reading a file outside the working directory", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "resin-derivation-outside-"));
    directories.push(outside);
    const secret = path.join(outside, "secret.json");
    writeFileSync(secret, JSON.stringify({ account_type: "R", mcc: 5942 }));
    const { step } = await runDerivation(
      `import json\njson.load(open(${JSON.stringify(secret)}))\n`,
    );
    expect(step.status).toBe("failed");
    // A symlink inside the workspace does not reach outside either.
    const scope = workspace();
    symlinkSync(secret, path.join(scope.dir, "link.json"));
    const linked = await runDerivation('import json\njson.load(open("link.json"))\n', scope);
    expect(linked.step.status).toBe("failed");
  });

  it("refuses connecting to a TCP server", async () => {
    const peers: string[] = [];
    let accepted = Promise.withResolvers<void>();
    const server = createServer((socket) => {
      peers.push(String(socket.remotePort));
      socket.destroy();
      accepted.resolve();
    });
    const listening = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const { step } = await runDerivation(
        `import socket\nsocket.create_connection(("127.0.0.1", ${port}))\n${LOOKUP}`,
      );
      expect(step.status).toBe("failed");
      // A probe connection after the run is accepted after any the derivation made.
      accepted = Promise.withResolvers<void>();
      const probe = connect(port, "127.0.0.1");
      const probePort = Promise.withResolvers<string>();
      probe.on("connect", () => probePort.resolve(String(probe.localPort)));
      probe.on("error", () => undefined);
      await accepted.promise;
      expect(peers).toEqual([await probePort.promise]);
    } finally {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
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
