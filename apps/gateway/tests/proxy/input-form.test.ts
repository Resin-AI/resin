/**
 * A confirmed input whose recorded values all named entries of one workspace directory: the device
 * reports the directory (`services`), never the values (`billing`, `search`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecordedWorkflow, WorkflowBindingCandidate } from "@resin/contracts";
import { RESIN_LOCAL_SOURCE_INTERFACE_KEY } from "@resin/harness-contracts";
import { InMemoryPrivateValueStore } from "@resin/observer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordedInputForm } from "../../src/proxy/input-form.js";
import { createRecordingCheckValidator } from "../../src/proxy/workflow-validation.js";
import { type RecordedTurn, localCallsFor, recordSession } from "./recorded-sessions.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "resin-input-form-"));
  for (const service of ["billing", "search", "auth"]) {
    mkdirSync(path.join(root, "services", service), { recursive: true });
  }
  mkdirSync(path.join(root, "sources"), { recursive: true });
  writeFileSync(path.join(root, "sources", "alpha.json"), "{}");
  writeFileSync(path.join(root, "sources", "beta.json"), "{}");
  writeFileSync(path.join(root, "README.md"), "");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the form of an input's recorded values", () => {
  it("names the directory every value is an entry of, and never a value", async () => {
    const form = await recordedInputForm([
      { value: "billing", base: root },
      { value: "search", base: root },
    ]);
    expect(form).toEqual({ value: "name", directory: "services", entry: "directory" });
    expect(JSON.stringify(form)).not.toMatch(/billing|search/u);
  });

  it("has no form when one value is not an entry of the same directory", async () => {
    expect(
      await recordedInputForm([
        { value: "billing", base: root },
        { value: "ledger", base: root },
      ]),
    ).toBeUndefined();
    expect(
      await recordedInputForm([
        { value: "billing", base: root },
        { value: "README.md", base: root },
      ]),
    ).toBeUndefined();
  });

  it("has no form when two directories at the same depth both hold every value", async () => {
    mkdirSync(path.join(root, "archive", "billing"), { recursive: true });
    mkdirSync(path.join(root, "archive", "search"), { recursive: true });
    expect(
      await recordedInputForm([
        { value: "billing", base: root },
        { value: "search", base: root },
      ]),
    ).toBeUndefined();
  });

  it("names the directory every path value lies under", async () => {
    const form = await recordedInputForm([
      { value: "sources/alpha.json", base: root },
      { value: "sources/beta.json", base: root },
    ]);
    expect(form).toEqual({ value: "path", directory: "sources", entry: "file" });
  });

  it("has no form for paths that share no directory, or a path that does not exist", async () => {
    expect(
      await recordedInputForm([
        { value: "sources/alpha.json", base: root },
        { value: "services/billing", base: root },
      ]),
    ).toBeUndefined();
    expect(
      await recordedInputForm([
        { value: "sources/alpha.json", base: root },
        { value: "sources/gamma.json", base: root },
      ]),
    ).toBeUndefined();
  });

  it("has no form when names and paths are mixed or a value leaves the working directory", async () => {
    expect(
      await recordedInputForm([
        { value: "billing", base: root },
        { value: "services/search", base: root },
      ]),
    ).toBeUndefined();
    expect(
      await recordedInputForm([
        { value: "../outside/a", base: root },
        { value: "../outside/b", base: root },
      ]),
    ).toBeUndefined();
  });
});

describe("a confirmed input whose values name service directories", () => {
  const owner = "input-form-owner";

  function release(callId: string, service: string): RecordedTurn[] {
    return [
      { user: `Release ${service}` },
      {
        callId,
        toolName: "bash",
        parameters: { command: `python3 scripts/build.py ${service}`, cwd: ".", timeout: 60 },
        result: `built ${service}\n`,
        metadata: { [RESIN_LOCAL_SOURCE_INTERFACE_KEY]: "omp-bash" },
      },
    ];
  }

  async function verdict(heldOutService: string) {
    const store = new InMemoryPrivateValueStore();
    const plan = recordSession(
      store,
      { workspaceId: owner, sessionId: "run-billing", workflowId: "wf_billing" },
      release("build_billing", "billing"),
    );
    recordSession(
      store,
      { workspaceId: owner, sessionId: "run-other", workflowId: "wf_other" },
      release("build_other", heldOutService),
    );
    const step = plan.steps[0]!;
    const candidate: WorkflowBindingCandidate = {
      stepId: step.id,
      argument: "command",
      path: ["tokens", 2],
      proposed: { kind: "input", name: "text", type: "string" },
      reason: "native-data-argument",
    };
    const asked: RecordedWorkflow = {
      ...plan,
      candidates: [candidate],
      heldOut: { inputs: [], observed: [], calls: [{ stepId: step.id, callIds: ["build_other"] }] },
    };
    const answer = await createRecordingCheckValidator({
      workspaceId: owner,
      privateValues: store,
      localCalls: localCallsFor(store, owner, ["run-billing", "run-other"], root),
    })(asked);
    expect(answer.unavailable).toBeUndefined();
    return answer.verdicts[0]!;
  }

  it("reports the directory the values are entries of", async () => {
    const confirmed = await verdict("search");
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.form).toEqual({ value: "name", directory: "services", entry: "directory" });
    expect(JSON.stringify(confirmed.form)).not.toMatch(/billing|search/u);
  });

  it("reports no form when the held-out value is no entry of that directory", async () => {
    const confirmed = await verdict("ledger");
    expect(confirmed.confirmed).toBe(true);
    expect(confirmed.form).toBeUndefined();
  });
});
