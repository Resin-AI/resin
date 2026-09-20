import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FilePrivateValueStore,
  NormalizationPipeline,
  WorkflowCallRecorder,
  projectEventToMetadataOnly,
  recordCallsFromEvents,
  resolvePrivateReference,
} from "@resin/observer";
import { it } from "vitest";
import {
  RuntimeAdapterRegistry,
  compileRecordedWorkflow,
  createProcessAdapter,
  demonstrationEnvironment,
  instantiateRecordedWorkflow,
  validateAndConfirmCandidates,
} from "../../src/workflow/index.js";

it.skipIf(process.platform === "win32")(
  "learns a path from redacted native programs and reuses two new files",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "resin-actual-replay-"));
    const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
    const code =
      'import csv,json,sys,hashlib; p=sys.argv[1]; rows=list(csv.DictReader(open(p))); print(json.dumps({"total":sum(float(r["amount"]) for r in rows),"count":len(rows),"digest":hashlib.sha256(open(p,"rb").read()).hexdigest()},sort_keys=True))';
    try {
      const paths = [
        "recorded-one.csv",
        "recorded-two.csv",
        "new file 'quoted'.csv",
        "new-$value;data.csv",
      ].map((name) => join(root, name));
      const bodies = ["amount\n1\n2\n", "amount\n7\n4\n", "amount\n12\n9\n8\n", "amount\n40\n2\n"];
      for (let i = 0; i < paths.length; i++) writeFileSync(paths[i], bodies[i]);
      const command = (p) => `python3 -c ${quote(code)} ${quote(p)}`;
      const answers = paths.map((p) =>
        execFileSync("/bin/sh", ["-c", command(p)], { encoding: "utf8" }),
      );
      const originals = [readFileSync(paths[0]), readFileSync(paths[1])];
      const store = new FilePrivateValueStore(join(root, "private"));
      const recorder = new WorkflowCallRecorder({ privateValues: store });
      const pipeline = new NormalizationPipeline({
        privateValueStore: store,
        redactionConfig: {
          maxStringLength: 48,
          customSecrets: [JSON.parse(answers[0]).digest, JSON.parse(answers[1]).digest],
        },
      });
      const sessionId = "session-native-acceptance";
      const workspaceId = "ws-native-acceptance";
      const raw = [
        {
          type: "tool_call",
          callId: "call-first",
          toolName: "bash",
          parameters: { command: command(paths[0]) },
        },
        {
          type: "tool_result",
          callId: "call-first",
          toolName: "bash",
          result: answers[0],
          isError: false,
          executionDurationMs: 1,
        },
        { type: "message", role: "user", content: "Now do the other file" },
        {
          type: "tool_call",
          callId: "call-repeat",
          toolName: "bash",
          parameters: { command: command(paths[1]) },
        },
        {
          type: "tool_result",
          callId: "call-repeat",
          toolName: "bash",
          result: answers[1],
          isError: false,
          executionDurationMs: 1,
        },
      ];
      const events = [];
      for (let i = 0; i < raw.length; i++) {
        const result = await pipeline.processIntermediateEvent(
          {
            ...raw[i],
            sessionId,
            timestamp: "2026-09-19T00:00:00.000Z",
            causalRef: { causalSequence: i + 1, parentId: null },
          },
          { sessionId, workspaceId },
        );
        assert.equal(result.status, "success");
        assert.ok(!JSON.stringify(result.event).includes(code));
        events.push(projectEventToMetadataOnly(recorder.observe(result.event, { workspaceId })));
      }
      const recipe = recordCallsFromEvents("workflow-native-acceptance", events.slice(0, 2), {
        supportingEvents: events.slice(2),
      });
      assert.equal(recipe.workflow.steps.length, 1);
      assert.ok(recipe.workflow.candidates.length > 0);
      const resolve = (reference) => {
        assert.equal(store.origin(reference)?.workspaceId, workspaceId);
        return resolvePrivateReference(store, reference);
      };
      assert.equal(resolve(recipe.workflow.heldOut.observed[0].reference), answers[1]);
      const adapters = new RuntimeAdapterRegistry();
      adapters.register(
        createProcessAdapter({
          cwd: root,
          env: { PATH: process.env.PATH },
          isolateEnvironment: true,
          timeoutMs: 5000,
        }),
      );
      const environment = await demonstrationEnvironment({
        plan: recipe.workflow,
        candidates: recipe.workflow.candidates,
        adapters,
        workspaceDir: root,
        resolvePrivate: resolve,
        timeoutMs: 10000,
      });
      const validated = await validateAndConfirmCandidates({
        plan: recipe.workflow,
        candidates: recipe.workflow.candidates,
        environment,
      });
      assert.equal(validated.verification.status, "verified");
      const artifact = compileRecordedWorkflow(validated.plan);
      assert.equal(artifact.plan.inputs.length, 1);
      const tool = instantiateRecordedWorkflow(artifact, {
        adapters,
        resolvePrivate: resolve,
        access: { workspaceId },
      });
      const name = artifact.plan.inputs[0].name;
      const results = [];
      for (let i = 2; i < paths.length; i++) {
        const execution = await tool.invoke({ [name]: paths[i] });
        assert.equal(execution.status, "completed");
        assert.equal(execution.result, answers[i]);
        const actual = JSON.parse(execution.result);
        assert.equal(actual.digest, createHash("sha256").update(bodies[i]).digest("hex"));
        results.push({ total: actual.total, count: actual.count });
      }
      assert.deepEqual(readFileSync(paths[0]), originals[0]);
      assert.deepEqual(readFileSync(paths[1]), originals[1]);
      assert.deepEqual(results, [
        { total: 29, count: 3 },
        { total: 42, count: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
