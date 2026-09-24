import { describe, expect, it } from "vitest";
import {
  type RecordedWorkflow,
  type WorkflowRecordedProgram,
  collectWorkflowPrivateReferences,
  validateRecordedWorkflow,
} from "../src/recorded-workflow.js";

/** fetch -> calculate -> write -> upload: four calls, values flowing through results. */
function fourCallWorkflow(): RecordedWorkflow {
  return {
    schemaVersion: 1,
    workflowId: "wf_fetch_calculate_write_upload",
    inputs: [
      { name: "source", type: "string" as const },
      { name: "target", type: "string" as const },
    ],
    privateReferences: ["secret:storage_token"],
    steps: [
      {
        id: "fetch",
        callId: "call_1",
        callable: { runtime: "mcp", name: "unfamiliar.fetch", connection: "srv_local" },
        arguments: [{ name: "source", source: { kind: "input", name: "source" } }],
        dependsOn: [],
        failurePolicy: { onError: "abort" as const, policy: "recorded" as const },
        observed: { outcome: "succeeded" as const },
      },
      {
        id: "calculate",
        callId: "call_2",
        callable: { runtime: "shell", name: "python3" },
        arguments: [
          { name: "stdin", source: { kind: "result", stepId: "fetch", path: ["body", "rows", 0] } },
        ],
        dependsOn: ["fetch"],
        failurePolicy: { onError: "abort" as const, policy: "recorded" as const },
        observed: { outcome: "succeeded" as const },
      },
      {
        id: "write",
        callId: "call_3",
        callable: { runtime: "shell", name: "tee" },
        arguments: [
          { name: "path", source: { kind: "input", name: "target" } },
          { name: "content", source: { kind: "result", stepId: "calculate", path: ["stdout"] } },
        ],
        dependsOn: ["calculate"],
        failurePolicy: { onError: "abort" as const, policy: "recorded" as const },
        observed: { outcome: "succeeded" as const },
      },
      {
        id: "upload",
        callId: "call_4",
        callable: { runtime: "mcp", name: "unfamiliar.upload", connection: "srv_local" },
        arguments: [
          { name: "file", source: { kind: "result", stepId: "write", path: ["path"] } },
          { name: "token", source: { kind: "private", reference: "secret:storage_token" } },
        ],
        dependsOn: ["write"],
        failurePolicy: { onError: "abort" as const, policy: "recorded" as const },
        observed: { outcome: "succeeded" as const },
      },
    ],
  };
}

function workflowWithProgramTemplate(
  template: unknown,
  additionalPrivateReferences: string[] = ["private:original-program"],
): unknown {
  const workflow = fourCallWorkflow();
  return {
    ...workflow,
    privateReferences: [...(workflow.privateReferences ?? []), ...additionalPrivateReferences],
    steps: workflow.steps.map((step, index) =>
      index === 0
        ? {
            ...step,
            arguments: [
              {
                name: "command",
                source: { kind: "template", template },
              },
            ],
          }
        : step,
    ),
  };
}

describe("recorded workflow validation", () => {
  it("accepts a workflow of unfamiliar callables bound through results, inputs and private references", () => {
    const result = validateRecordedWorkflow(fourCallWorkflow());
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("rejects a binding to a step that does not come earlier", () => {
    const workflow = fourCallWorkflow();
    const result = validateRecordedWorkflow({
      ...workflow,
      steps: [workflow.steps[1]!, workflow.steps[0]!, workflow.steps[2]!, workflow.steps[3]!],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("does not come earlier");
  });

  it("rejects an input the workflow never declares", () => {
    const workflow = fourCallWorkflow();
    const result = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [{ name: "source", source: { kind: "input", name: "missing" } }],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("unknown input");
  });

  it("says nothing about which tools are supported", () => {
    const workflow = fourCallWorkflow();
    const renamed = validateRecordedWorkflow({
      ...workflow,
      steps: workflow.steps.map((step) => ({
        ...step,
        callable: { runtime: `runtime-${step.id}`, name: `made-up-${step.id}` },
      })),
    });
    // The same shape validates: compilability is representability, not recognition.
    expect(renamed.valid).toBe(true);
  });

  it("requires a failure policy, an observed outcome, and a recorded input type", () => {
    const workflow = fourCallWorkflow();
    const missingPolicy = validateRecordedWorkflow({
      ...workflow,
      steps: workflow.steps.map((step) => {
        const { failurePolicy: _dropped, ...rest } = step;
        return rest;
      }),
    });
    expect(missingPolicy.valid).toBe(false);
    expect(missingPolicy.errors.join("\n")).toContain("failurePolicy");

    const untypedInput = validateRecordedWorkflow({
      ...workflow,
      inputs: [{ name: "source" }],
    });
    expect(untypedInput.valid).toBe(false);
    expect(untypedInput.errors.join("\n")).toContain("recorded type");
  });

  it("accepts defaults that match their declared types and rejects incompatible defaults", () => {
    const workflow = fourCallWorkflow();
    workflow.inputs = [
      { ...workflow.inputs[0]!, default: "" },
      { ...workflow.inputs[1]!, default: "" },
      { name: "retries", type: "number", default: 0 },
      { name: "enabled", type: "boolean", default: false },
      { name: "options", type: "object", default: { depth: 2 } },
      { name: "labels", type: "array", default: [] },
    ];
    expect(validateRecordedWorkflow(workflow).valid).toBe(true);

    const incompatible = validateRecordedWorkflow({
      ...workflow,
      inputs: [...workflow.inputs, { name: "limit", type: "number", default: false }],
    });
    expect(incompatible.valid).toBe(false);
    expect(incompatible.errors.join("\n")).toContain(
      "input limit default must match its recorded type 'number'",
    );

    const nullDefault = validateRecordedWorkflow({
      ...workflow,
      inputs: [{ name: "source", type: "string", default: null }, workflow.inputs[1]!],
    });
    expect(nullDefault.valid).toBe(false);
    expect(nullDefault.errors.join("\n")).toContain(
      "input source default must match its recorded type 'string'",
    );
  });

  it("validates recursively constructed arguments, including unknown origins", () => {
    const workflow = fourCallWorkflow();
    const templated = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [
            {
              name: "source",
              source: {
                kind: "template",
                template: {
                  type: "object",
                  entries: {
                    inner: { type: "input", name: "source" },
                    unknown: { type: "unresolved", reason: "not recorded" },
                  },
                },
              },
            },
          ],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(templated.errors).toEqual([]);

    const brokenTemplate = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [
            {
              name: "source",
              source: {
                kind: "template",
                template: {
                  type: "object",
                  entries: { inner: { type: "input", name: "missing" } },
                },
              },
            },
          ],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(brokenTemplate.valid).toBe(false);
    expect(brokenTemplate.errors.join("\n")).toContain("unknown input");
  });

  it("requires declared private references", () => {
    const workflow = fourCallWorkflow();

    const undeclared = validateRecordedWorkflow({ ...workflow, privateReferences: [] });
    expect(undeclared.valid).toBe(false);
    expect(undeclared.errors.join("\n")).toContain("undeclared private reference");

    const badPrivateList = validateRecordedWorkflow({ ...workflow, privateReferences: "secret" });
    expect(badPrivateList.valid).toBe(false);
    expect(badPrivateList.errors.join("\n")).toContain("privateReferences must be an array");
  });

  it("validates recursively constructed arguments, including unknown origins", () => {
    const workflow = fourCallWorkflow();
    const templated = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [
            {
              name: "source",
              source: {
                kind: "template",
                template: {
                  type: "object",
                  entries: {
                    inner: { type: "input", name: "source" },
                    unknown: { type: "unresolved", reason: "not recorded" },
                  },
                },
              },
            },
          ],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(templated.errors).toEqual([]);

    const brokenTemplate = validateRecordedWorkflow({
      ...workflow,
      steps: [
        {
          ...workflow.steps[0]!,
          arguments: [
            {
              name: "source",
              source: {
                kind: "template",
                template: {
                  type: "object",
                  entries: { inner: { type: "input", name: "missing" } },
                },
              },
            },
          ],
        },
        workflow.steps[1]!,
        workflow.steps[2]!,
        workflow.steps[3]!,
      ],
    });
    expect(brokenTemplate.valid).toBe(false);
    expect(brokenTemplate.errors.join("\n")).toContain("unknown input");
  });
  it("validates projected program metadata as a paired, fail-closed shape", () => {
    const projected = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: "echo '<redacted>'" },
      sourceReference: "private:original-program",
      protectedTokens: [2, 4],
      holes: [],
    };
    expect(validateRecordedWorkflow(workflowWithProgramTemplate(projected))).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(
      validateRecordedWorkflow(workflowWithProgramTemplate({ ...projected, protectedTokens: [] })),
    ).toMatchObject({ valid: true, errors: [] });

    const legacy = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: "echo 'unchanged'" },
      holes: [],
    };
    expect(validateRecordedWorkflow(workflowWithProgramTemplate(legacy, []))).toMatchObject({
      valid: true,
      errors: [],
    });

    const withoutProtectedTokens = Object.fromEntries(
      Object.entries(projected).filter(([key]) => key !== "protectedTokens"),
    );
    const withoutSourceReference = Object.fromEntries(
      Object.entries(projected).filter(([key]) => key !== "sourceReference"),
    );
    const invalidShapes: Array<{ template: unknown; error: string }> = [
      { template: withoutProtectedTokens, error: "together" },
      { template: withoutSourceReference, error: "together" },
      {
        template: { ...projected, source: { type: "literal", value: 42 } },
        error: "literal string",
      },
      {
        template: { ...projected, sourceReference: "" },
        error: "non-empty private sourceReference",
      },
      {
        template: { ...projected, sourceReference: 123 },
        error: "non-empty private sourceReference",
      },
      { template: { ...projected, protectedTokens: [4, 2] }, error: "sorted and unique" },
      { template: { ...projected, protectedTokens: [2, 2] }, error: "sorted and unique" },
      { template: { ...projected, protectedTokens: [-1] }, error: "non-negative integer" },
      { template: { ...projected, protectedTokens: [2, 2.5] }, error: "non-negative integer" },
      { template: { ...projected, protectedTokens: "2" }, error: "must be an array" },
    ];
    for (const { template, error } of invalidShapes) {
      const result = validateRecordedWorkflow(workflowWithProgramTemplate(template));
      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toContain(error);
    }

    const undeclared = validateRecordedWorkflow(workflowWithProgramTemplate(projected, []));
    expect(undeclared.valid).toBe(false);
    expect(undeclared.errors.join("\n")).toContain("undeclared private reference");
  });

  it("rejects holes that target protected program tokens", () => {
    const protectedHole = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: "echo '<redacted>'" },
      sourceReference: "private:original-program",
      protectedTokens: [2],
      holes: [{ token: 2, binding: { type: "literal", value: "replacement" } }],
    };
    const rejected = validateRecordedWorkflow(workflowWithProgramTemplate(protectedHole));
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.join("\n")).toContain("targets a protected token index");

    const unprotectedHole = {
      ...protectedHole,
      holes: [{ token: 1, binding: { type: "literal", value: "replacement" } }],
    };
    expect(validateRecordedWorkflow(workflowWithProgramTemplate(unprotectedHole))).toMatchObject({
      valid: true,
      errors: [],
    });
  });

  it("keeps projected callable source aligned only with its matching top-level argument", () => {
    const projected = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: "echo '<redacted>'" },
      sourceReference: "private:original-program",
      protectedTokens: [],
      holes: [],
    };
    const withProgram = (template: unknown, programSource: string) => {
      const workflow = fourCallWorkflow();
      return {
        ...workflow,
        privateReferences: [...(workflow.privateReferences ?? []), "private:original-program"],
        steps: workflow.steps.map((step, index) =>
          index === 0
            ? {
                ...step,
                callable: {
                  ...step.callable,
                  program: { kind: "shell", source: programSource, argument: "command" },
                },
                arguments: [{ name: "command", source: { kind: "template", template } }],
              }
            : step,
        ),
      };
    };
    expect(validateRecordedWorkflow(withProgram(projected, "echo '<redacted>'"))).toMatchObject({
      valid: true,
      errors: [],
    });

    const divergent = validateRecordedWorkflow(withProgram(projected, "echo '<other>'"));
    expect(divergent.valid).toBe(false);
    expect(divergent.errors.join("\n")).toContain("differs from projected argument command");

    const legacy = {
      type: "program",
      language: "shell",
      source: { type: "literal", value: "echo '<legacy>'" },
      holes: [],
    };
    expect(validateRecordedWorkflow(withProgram(legacy, "echo '<different>'"))).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(
      validateRecordedWorkflow(
        withProgram({ type: "object", entries: { nested: projected } }, "echo '<different>'"),
      ),
    ).toMatchObject({ valid: true, errors: [] });
  });

  it("collects original program and nested hole private references", () => {
    const template = {
      type: "object",
      entries: {
        program: {
          type: "program",
          language: "shell",
          source: { type: "literal", value: "echo '<redacted>'" },
          sourceReference: "private:original-program",
          protectedTokens: [2],
          holes: [
            {
              token: 1,
              binding: {
                type: "array",
                items: [
                  { type: "private", reference: "private:hole-one" },
                  {
                    type: "object",
                    entries: { nested: { type: "private", reference: "private:hole-two" } },
                  },
                ],
              },
            },
          ],
        },
        sibling: { type: "private", reference: "private:sibling" },
      },
    };
    const workflow = workflowWithProgramTemplate(template, []) as RecordedWorkflow;
    expect(collectWorkflowPrivateReferences(workflow)).toEqual([
      "secret:storage_token",
      "private:original-program",
      "private:hole-one",
      "private:hole-two",
      "private:sibling",
    ]);
  });

  it("admits explicit language-specific Eval and Codex exec semantics and rejects mismatches", () => {
    const workflow = fourCallWorkflow();
    const withProgram = (program: unknown) => ({
      ...workflow,
      steps: workflow.steps.map((step, index) =>
        index === 1 ? { ...step, callable: { ...step.callable, program } } : step,
      ),
    });
    const pythonProgram: WorkflowRecordedProgram = {
      kind: "python",
      source: "1 + 2",
      sourceInterface: "python-eval",
    };
    expect(validateRecordedWorkflow(withProgram(pythonProgram))).toMatchObject({
      valid: true,
      errors: [],
    });
    const mismatchedPython = validateRecordedWorkflow(
      withProgram({ ...pythonProgram, kind: "shell" }),
    );
    expect(mismatchedPython.valid).toBe(false);
    expect(mismatchedPython.errors.join("\n")).toContain("non-Python");

    const javascriptProgram: WorkflowRecordedProgram = {
      kind: "javascript",
      source: "1 + 2",
      sourceInterface: "javascript-eval",
    };
    expect(validateRecordedWorkflow(withProgram(javascriptProgram))).toMatchObject({
      valid: true,
      errors: [],
    });
    const mismatchedJavaScript = validateRecordedWorkflow(
      withProgram({ ...javascriptProgram, kind: "typescript" }),
    );
    expect(mismatchedJavaScript.valid).toBe(false);
    expect(mismatchedJavaScript.errors.join("\n")).toContain("non-JavaScript");

    const codexProgram: WorkflowRecordedProgram = {
      kind: "javascript",
      source: "text('native output')",
      sourceInterface: "codex-exec",
    };
    expect(validateRecordedWorkflow(withProgram(codexProgram))).toMatchObject({
      valid: true,
      errors: [],
    });
    const mismatchedCodex = validateRecordedWorkflow(
      withProgram({ ...codexProgram, kind: "typescript" }),
    );
    expect(mismatchedCodex.valid).toBe(false);
    expect(mismatchedCodex.errors.join("\n")).toContain("non-JavaScript");

    const unknown = validateRecordedWorkflow(
      withProgram({ ...javascriptProgram, sourceInterface: "unknown-eval" }),
    );
    expect(unknown.valid).toBe(false);
    expect(unknown.errors.join("\n")).toContain("unsupported program sourceInterface");
  });

  it("validates Python closure descriptors and collects baseline references without source metadata", () => {
    const workflow = fourCallWorkflow();
    const program: WorkflowRecordedProgram = {
      kind: "python",
      source: "print(bump(5))",
      pythonState: {
        schemaVersion: 1,
        status: "closed",
        unresolvedReadCount: 0,
        setup: [
          {
            callId: "python-setup-call",
            sourceEventId: "python-setup-source",
            resultEventId: "python-setup-result",
            reference: "private:python-setup",
          },
        ],
      },
    };
    const closed: RecordedWorkflow = {
      ...workflow,
      privateReferences: [
        ...(workflow.privateReferences ?? []),
        "private:python-setup",
        "private:baseline",
      ],
      steps: [
        { ...workflow.steps[0]!, callable: { ...workflow.steps[0]!.callable, program } },
        ...workflow.steps.slice(1),
      ],
      baseline: {
        inputs: [{ stepId: "fetch", argument: "source", reference: "private:baseline" }],
        observed: [{ stepId: "fetch", reference: "private:baseline" }],
      },
    };
    expect(validateRecordedWorkflow(closed)).toMatchObject({ valid: true, errors: [] });
    expect(collectWorkflowPrivateReferences(closed)).toEqual([
      "secret:storage_token",
      "private:python-setup",
      "private:baseline",
    ]);
    expect(JSON.stringify(program.pythonState)).not.toContain("bump");

    const unresolved = validateRecordedWorkflow({
      ...closed,
      steps: [
        {
          ...closed.steps[0]!,
          callable: {
            ...closed.steps[0]!.callable,
            program: {
              ...program,
              pythonState: { ...program.pythonState!, status: "unresolved" },
            },
          },
        },
        ...closed.steps.slice(1),
      ],
    });
    expect(unresolved.valid).toBe(false);
    expect(unresolved.errors.join("\n")).toContain("unresolved");

    const overlapping = validateRecordedWorkflow({
      ...closed,
      steps: [
        {
          ...closed.steps[0]!,
          callable: {
            ...closed.steps[0]!.callable,
            program: {
              ...program,
              pythonState: {
                ...program.pythonState!,
                setup: [{ ...program.pythonState!.setup[0]!, callId: "call_2" }],
              },
            },
          },
        },
        ...closed.steps.slice(1),
      ],
    });
    expect(overlapping.valid).toBe(false);
    expect(overlapping.errors.join("\n")).toContain("overlaps workflow callId");

    const duplicate = validateRecordedWorkflow({
      ...closed,
      steps: [
        {
          ...closed.steps[0]!,
          callable: {
            ...closed.steps[0]!.callable,
            program: {
              ...program,
              pythonState: {
                ...program.pythonState!,
                setup: [
                  ...program.pythonState!.setup,
                  { ...program.pythonState!.setup[0]!, reference: "private:other" },
                ],
              },
            },
          },
        },
        ...closed.steps.slice(1),
      ],
    });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.errors.join("\n")).toContain("duplicates callId");
  });
  it("accepts explicit observed comparison modes on baseline and held-out evidence", () => {
    const workflow = fourCallWorkflow();
    const withComparison: RecordedWorkflow = {
      ...workflow,
      privateReferences: [...(workflow.privateReferences ?? []), "private:observed"],
      baseline: {
        inputs: [],
        observed: [{ stepId: "fetch", reference: "private:observed", comparison: "text-trim" }],
      },
      heldOut: {
        inputs: [],
        observed: [{ stepId: "fetch", reference: "private:observed", comparison: "text-trim" }],
      },
    };
    for (const label of ["baseline", "heldOut"] as const) {
      const invalid = validateRecordedWorkflow({
        ...withComparison,
        [label]: {
          inputs: [],
          observed: [
            {
              stepId: "fetch",
              reference: "private:observed",
              comparison: "unknown-mode",
            },
          ],
        },
      });
      expect(invalid.valid).toBe(false);
      expect(invalid.errors.join("\n")).toContain(`${label}.observed`);
      expect(invalid.errors.join("\n")).toContain("unsupported comparison");
    }
  });
});
