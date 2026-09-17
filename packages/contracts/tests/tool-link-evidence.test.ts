import {
  RESIN_TOOL_LINK_EVIDENCE_KEY,
  TOOL_LINK_CONTENT_KINDS,
  TOOL_LINK_EVIDENCE_LIMITS,
  TOOL_LINK_EVIDENCE_VERSION,
  TOOL_LINK_INPUT_NAMES,
  TOOL_LINK_OBSERVATION_STATUSES,
  TOOL_LINK_OPERATIONS,
  TOOL_LINK_RESOURCE_KINDS,
  type ToolLinkEvidenceV1,
  ToolLinkEvidenceV1Schema,
  readToolLinkEvidence,
} from "../src/tool-link-evidence.js";

function pendingCarrier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    scopeId: "evt_scope_0001",
    operation: "github.issue.read",
    reads: [{ kind: "github_issue", ref: "r0" }],
    writes: [{ kind: "file", ref: "r1" }],
    inputs: [
      { name: "subject", ref: "r0" },
      { name: "target", ref: "r1" },
    ],
    contentKinds: [],
    observation: {
      callId: "call_0001",
      callEventId: "evt_call_0001",
      status: "pending",
    },
    ...overrides,
  };
}

function completedCarrier(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const carrier = pendingCarrier(overrides);
  return {
    ...carrier,
    observation: {
      callId: "call_0001",
      callEventId: "evt_call_0001",
      resultEventId: "evt_result_0001",
      status: "success",
    },
    ...(overrides.observation === undefined ? {} : { observation: overrides.observation }),
  };
}

function transformCarrier(): Record<string, unknown> {
  return {
    version: 1,
    scopeId: "evt_scope_0001",
    operation: "file.transform",
    reads: [{ kind: "file", ref: "r1" }],
    writes: [{ kind: "file", ref: "r2" }],
    inputs: [
      { name: "source", ref: "r1" },
      { name: "target", ref: "r2" },
    ],
    contentKinds: ["markdown_checklist"],
    observation: {
      callId: "call_0002",
      callEventId: "evt_call_0002",
      resultEventId: "evt_result_0002",
      status: "success",
    },
  };
}

function issueUpdateCarrier(): Record<string, unknown> {
  return {
    version: 1,
    scopeId: "evt_scope_0001",
    operation: "github.issue.update",
    reads: [{ kind: "file", ref: "r2" }],
    writes: [{ kind: "github_issue", ref: "r0" }],
    inputs: [
      { name: "subject", ref: "r0" },
      { name: "changes", ref: "r2" },
    ],
    contentKinds: [],
    observation: {
      callId: "call_0003",
      callEventId: "evt_call_0003",
      resultEventId: "evt_result_0003",
      status: "success",
    },
  };
}

function expectRejected(value: unknown): void {
  expect(readToolLinkEvidence(value)).toBeUndefined();
  expect(ToolLinkEvidenceV1Schema.safeParse(value).success).toBe(false);
}

describe("tool link evidence contract surface", () => {
  it("pins the metadata key, version, and finite vocabularies", () => {
    expect(RESIN_TOOL_LINK_EVIDENCE_KEY).toBe("resinToolLinkV1");
    expect(TOOL_LINK_EVIDENCE_VERSION).toBe(1);
    expect([...TOOL_LINK_OPERATIONS]).toEqual([
      "github.issue.read",
      "github.issue.update",
      "file.read",
      "file.write",
      "file.transform",
      "command.exec",
    ]);
    expect([...TOOL_LINK_RESOURCE_KINDS]).toEqual(["file", "github_issue", "value"]);
    expect([...TOOL_LINK_INPUT_NAMES]).toEqual(["subject", "source", "target", "changes"]);
    expect([...TOOL_LINK_CONTENT_KINDS]).toEqual(["markdown_checklist"]);
    expect([...TOOL_LINK_OBSERVATION_STATUSES]).toEqual(["pending", "success", "failure"]);
    expect(TOOL_LINK_EVIDENCE_LIMITS.maxRefIndex).toBe(999);
  });

  it("reads the declared read -> transform -> update chain of one scope", () => {
    const read = readToolLinkEvidence(pendingCarrier());
    const transform = readToolLinkEvidence(transformCarrier());
    const update = readToolLinkEvidence(issueUpdateCarrier());

    expect(read?.operation).toBe("github.issue.read");
    expect(transform?.operation).toBe("file.transform");
    expect(update?.operation).toBe("github.issue.update");
    // Refs are resource identities: the file a read declares as written is the file the transform
    // declares as read, and the issue the update writes is the issue the read declares as subject.
    expect(read?.writes[0]?.ref).toBe(transform?.reads[0]?.ref);
    expect(transform?.writes[0]?.ref).toBe(update?.reads[0]?.ref);
    expect(update?.writes[0]?.ref).toBe(read?.reads[0]?.ref);
    expect(transform?.contentKinds).toEqual(["markdown_checklist"]);
  });

  it("is idempotent under repeated reads of its own output", () => {
    const first = readToolLinkEvidence(transformCarrier()) as ToolLinkEvidenceV1;
    const second = readToolLinkEvidence(JSON.parse(JSON.stringify(first)));
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("requires a strict envelope with no unknown keys", () => {
    expectRejected({ ...pendingCarrier(), rawPath: "/tmp/body.md" });
    expectRejected({ ...pendingCarrier(), version: 2 });
    expectRejected({ ...pendingCarrier(), operation: "gh.issue.read" });
    expectRejected({ ...pendingCarrier(), scopeId: "" });
    expectRejected({ ...pendingCarrier(), scopeId: "${ISSUE}" });
    const withoutInputs = pendingCarrier();
    delete withoutInputs.inputs;
    expectRejected(withoutInputs);
  });

  it("bounds resource ordinals and never accepts a value-shaped ref", () => {
    expect(
      readToolLinkEvidence({
        ...pendingCarrier(),
        writes: [{ kind: "file", ref: "r999" }],
        inputs: [{ name: "subject", ref: "r0" }],
      }),
    ).toBeDefined();
    expectRejected({ ...pendingCarrier(), writes: [{ kind: "file", ref: "r1000" }] });
    expectRejected({ ...pendingCarrier(), writes: [{ kind: "file", ref: "r0001" }] });
    expectRejected({ ...pendingCarrier(), writes: [{ kind: "file", ref: "/tmp/body.md" }] });
    expectRejected({
      ...pendingCarrier(),
      writes: [{ kind: "file", ref: "r1", path: "/tmp/body.md" }],
    });
  });

  it("keeps one kind per ref, deduplicates refs, and rejects dangling input refs", () => {
    expectRejected({
      ...pendingCarrier(),
      reads: [
        { kind: "github_issue", ref: "r0" },
        { kind: "file", ref: "r0" },
      ],
    });
    expectRejected({
      ...pendingCarrier(),
      reads: [
        { kind: "github_issue", ref: "r0" },
        { kind: "github_issue", ref: "r0" },
      ],
    });
    expectRejected({
      ...pendingCarrier(),
      inputs: [{ name: "subject", ref: "r7" }],
    });
    expectRejected({
      ...pendingCarrier(),
      inputs: [
        { name: "subject", ref: "r0" },
        { name: "subject", ref: "r1" },
      ],
    });
  });

  it("rejects a carrier whose operation contradicts its own reads and writes", () => {
    expectRejected({ ...pendingCarrier(), operation: "file.read" });
    expectRejected({ ...pendingCarrier(), operation: "file.write" });
    expectRejected({ ...transformCarrier(), operation: "file.read" });
    expectRejected({
      ...transformCarrier(),
      reads: [],
    });
    expectRejected({
      ...transformCarrier(),
      writes: [],
    });
    expectRejected({
      ...issueUpdateCarrier(),
      writes: [{ kind: "file", ref: "r2" }],
    });
    expectRejected({
      ...issueUpdateCarrier(),
      reads: [{ kind: "github_issue", ref: "r0" }],
    });
    expectRejected({
      ...pendingCarrier(),
      reads: [],
      writes: [],
      inputs: [],
    });
  });

  it("ties status to the result event it claims", () => {
    expect(
      readToolLinkEvidence({
        ...pendingCarrier(),
        observation: {
          callId: "call_0001",
          callEventId: "evt_call_0001",
          resultEventId: "evt_result_0001",
          status: "pending",
        },
      }),
    ).toBeUndefined();
    expect(
      readToolLinkEvidence({
        ...pendingCarrier(),
        observation: { callId: "call_0001", callEventId: "evt_call_0001", status: "success" },
      }),
    ).toBeUndefined();
    expect(
      readToolLinkEvidence({
        ...pendingCarrier(),
        observation: {
          callId: "call_0001",
          callEventId: "evt_call_0001",
          resultEventId: "evt_result_0001",
          status: "failure",
        },
      }),
    ).toBeDefined();
    expect(
      readToolLinkEvidence({
        ...completedCarrier(),
        observation: {
          callId: "call_0001",
          callEventId: "evt_result_0001",
          resultEventId: "evt_result_0001",
          status: "success",
        },
      }),
    ).toBeDefined();
  });

  it("rejects untrusted payload shapes instead of repairing them", () => {
    expect(readToolLinkEvidence(undefined)).toBeUndefined();
    expect(readToolLinkEvidence(null)).toBeUndefined();
    expect(readToolLinkEvidence("resinToolLinkV1")).toBeUndefined();
    expect(readToolLinkEvidence(Object.create({ version: 1 }))).toBeUndefined();
    const withGetter: Record<string, unknown> = { ...pendingCarrier() };
    Object.defineProperty(withGetter, "operation", {
      get: () => {
        throw new Error("getter must never run");
      },
    });
    expect(readToolLinkEvidence(withGetter)).toBeUndefined();
    expect(
      readToolLinkEvidence({
        ...pendingCarrier(),
        contentKinds: new Array(8_000).fill("markdown_checklist"),
      }),
    ).toBeUndefined();
    const circular: Record<string, unknown> = { ...pendingCarrier() };
    circular.self = circular;
    expect(readToolLinkEvidence(circular)).toBeUndefined();
  });
});
