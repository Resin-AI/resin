import { OmpRecordDecoder } from "@resin/adapter-omp";
import type { NormalizedSessionEvent } from "@resin/contracts";
import type { RawHarnessRecord } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { NormalizationPipeline } from "../../src/normalization/index.js";
import type { RedactionConfig } from "../../src/normalization/redaction.js";

const sessionId = "01J5XYZ7890ABCDEFGHJKMNPQR";
const timestamp = "2026-08-17T12:00:00.000Z";

function ompToolCall(parameters: Record<string, unknown>): RawHarnessRecord {
  return {
    recordId: "cwd-source",
    sessionId,
    harnessId: "omp",
    sequenceNumber: 1,
    timestamp,
    recordType: "transcript_line",
    rawPayload: {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "cwd-call", name: "bash", arguments: parameters }],
      },
    },
    cursor: { offset: 0, line: 1, sequence: 1, timestamp },
    metadata: {},
  };
}

const command = "sha256sum ./PRIVATE_PACKAGE.bin && sha512sum ./PRIVATE_PACKAGE.bin";

function ompCommandExec(fields: Record<string, unknown>): RawHarnessRecord {
  return {
    ...ompToolCall({}),
    rawPayload: { type: "command_exec", command, args: [], exitCode: 0, ...fields },
  };
}

async function normalize(
  record: RawHarnessRecord,
  type: "tool_call" | "command_exec",
  redactionConfig?: RedactionConfig,
): Promise<NormalizedSessionEvent> {
  const pipeline = new NormalizationPipeline({ redactionConfig });
  pipeline.registerDecoder(new OmpRecordDecoder());
  const results = await pipeline.processRecord(record);
  const result = results.find((entry) => entry.status === "success" && entry.event.type === type);
  if (!result || result.status !== "success") throw new Error(`Expected normalized ${type}`);
  return result.event;
}

describe("cwd evidence through decoding, normalization, and projection", () => {
  it("preserves explicit workspace-relative root without uploading private command content", async () => {
    for (const cwd of [".", "./"]) {
      const pipeline = new NormalizationPipeline();
      pipeline.registerDecoder(new OmpRecordDecoder());
      const results = await pipeline.processRecord(
        ompToolCall({
          command: "sha256sum ./PRIVATE_PACKAGE.bin && sha512sum ./PRIVATE_PACKAGE.bin",
          cwd,
          i: "PRIVATE_INTENT",
        }),
      );
      const result = results.find(
        (entry) => entry.status === "success" && entry.event.type === "tool_call",
      );
      if (!result || result.status !== "success") throw new Error("Expected normalized tool call");
      const projected = projectEventToMetadataOnly(result.event, { validate: true });
      if (projected.type !== "tool_call") throw new Error("Expected projected tool call");
      expect(projected.parameters).toEqual({
        command: "sha256sum $PATH && sha512sum $PATH",
        cwd: ".",
      });
      expect(projected.metadata?.cwd).toBe(".");
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    }
  });

  it("does not promote private, missing, null, aliased, or nested tool cwd into root evidence", async () => {
    const parameters: Record<string, unknown>[] = [
      {},
      { cwd: null },
      { cwd: "/home/PRIVATE_USER/PRIVATE_REPO" },
      { cwd: "PRIVATE_REPO/subdir" },
      { cwd: "$REPO_ROOT" },
      { cwd: "$HOME" },
      { cwd: "[REDACTED_LOCAL_FIELD:cwd]" },
      { cwd: "_REDACTED_LOCAL_FIELD_cwd_" },
      { workingDirectory: "." },
      { context: { cwd: "." }, metadata: { cwd: "." } },
      { cwd: { cwd: "." } },
      { cwd: ["./"] },
    ];
    for (const fields of parameters) {
      const normalized = await normalize(ompToolCall({ command, ...fields }), "tool_call");
      const projected = projectEventToMetadataOnly(normalized, { validate: true });
      if (projected.type !== "tool_call") throw new Error("Expected tool call");
      expect(projected.metadata).not.toHaveProperty("cwd");
      if (Object.hasOwn(fields, "cwd")) {
        expect(projected.parameters.cwd).toBe("$PATH");
      } else {
        expect(projected.parameters).not.toHaveProperty("cwd");
      }
      const reprojected = projectEventToMetadataOnly(projected);
      if (reprojected.type !== "tool_call") throw new Error("Expected tool call");
      expect(reprojected.parameters.cwd).toBe(projected.parameters.cwd);
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    }
  });

  it("preserves native atomic command cwd aliases only when they explicitly name root", async () => {
    for (const fields of [{ cwd: "." }, { cwd: "./" }, { workingDirectory: "." }]) {
      const normalized = await normalize(ompCommandExec(fields), "command_exec");
      const projected = projectEventToMetadataOnly(normalized, { validate: true });
      if (projected.type !== "command_exec") throw new Error("Expected command execution");
      expect(projected.metadata?.cwd).toBe(".");
      expect(projected.cwd).toBeUndefined();
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    }
    for (const fields of [
      {},
      { cwd: null },
      { cwd: "/home/PRIVATE_USER/PRIVATE_REPO" },
      { workingDirectory: "PRIVATE_REPO/subdir" },
      { cwd: "$REPO_ROOT" },
      { cwd: "[REDACTED_LOCAL_FIELD:cwd]" },
      { cwd: "_REDACTED_LOCAL_FIELD_cwd_" },
      { metadata: { cwd: "." }, context: { cwd: "." } },
      { workingDirectory: "/PRIVATE_REPO", cwd: "." },
    ]) {
      const normalized = await normalize(ompCommandExec(fields), "command_exec");
      const projected = projectEventToMetadataOnly(normalized, { validate: true });
      expect(projected.metadata).not.toHaveProperty("cwd");
      expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
    }
  });

  it("honors explicit local-only and drop policies without resurrecting root evidence", async () => {
    for (const redactionConfig of [
      { strategy: "drop" },
      { localOnlyFields: ["cwd"] },
      { localOnlyFields: ["workingDirectory"] },
    ] satisfies RedactionConfig[]) {
      const normalized = await normalize(
        ompToolCall({ command, cwd: "." }),
        "tool_call",
        redactionConfig,
      );
      const projected = projectEventToMetadataOnly(normalized, { validate: true });
      expect(projected.metadata).not.toHaveProperty("cwd");
      if (projected.type !== "tool_call") throw new Error("Expected tool call");
      expect(projected.parameters.cwd).not.toBe(".");
    }
    for (const redactionConfig of [
      { strategy: "drop" },
      { localOnlyFields: ["cwd"] },
      { localOnlyFields: ["workingDirectory"] },
    ] satisfies RedactionConfig[]) {
      const normalized = await normalize(
        ompCommandExec({ workingDirectory: "." }),
        "command_exec",
        redactionConfig,
      );
      expect(
        projectEventToMetadataOnly(normalized, { validate: true }).metadata,
      ).not.toHaveProperty("cwd");
    }
    const pipeline = new NormalizationPipeline({
      redactionConfig: { localOnlyFields: ["parameters"] },
    });
    pipeline.registerDecoder(new OmpRecordDecoder());
    const results = await pipeline.processRecord(ompToolCall({ command, cwd: "." }));
    expect(results.some((result) => result.status === "dead_letter")).toBe(true);
    expect(
      results.some((result) => result.status === "success" && result.event.type === "tool_call"),
    ).toBe(false);
  });

  it("does not preserve nested local-only roots or bypass string redaction", async () => {
    const normalized = await normalize(
      ompToolCall({ command, cwd: ".", context: { cwd: ".", socketPath: "." } }),
      "tool_call",
    );
    if (normalized.type !== "tool_call") throw new Error("Expected tool call");
    expect(normalized.parameters.context).toEqual({
      cwd: "[REDACTED_LOCAL_FIELD:cwd]",
      socketPath: "[REDACTED_LOCAL_FIELD:socketPath]",
    });
    const aliased = await normalize(ompToolCall({ command, cwd: "./" }), "tool_call", {
      pathAliases: { "./": "PRIVATE_ALIAS" },
    });
    expect(projectEventToMetadataOnly(aliased).metadata).not.toHaveProperty("cwd");
    expect(
      projectEventToMetadataOnly(normalized, { enrichEvidence: false }).metadata,
    ).not.toHaveProperty("cwd");
  });
});
