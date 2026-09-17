import { z } from "zod";
import { descriptorSafeCanonicalJsonStringify } from "./canonical.js";
import { IdentifierSchema } from "./common.js";

/**
 * Tool Link Evidence Contract (analysis-only).
 *
 * This module freezes the serialization boundary for a *declared data-flow* statement observed
 * around one tool invocation: which resources the agent declared it would read, which it declared it
 * would write, and what semantic role each of those resources played. It is deliberately NOT a
 * transcript excerpt, not a command/parameter bag and not an authority grant: evidence never grants
 * filesystem, command, network or secret capability, and a captured carrier is untrusted DATA that
 * must never be executed, replayed or resolved against a real filesystem.
 *
 * Privacy posture (mirrors the computation-evidence and parameter-shape posture in this package):
 * a carrier contains no raw body, source, patch, prompt, path, repository, issue identifier, URL or
 * literal value, and no hash of a private value. Every string in a carrier is one of:
 *   - a bounded event/call identity (`scopeId`, `callId`, `callEventId`, `resultEventId`),
 *   - a finite vocabulary token (operation, resource kind, input name, content kind, status), or
 *   - a per-scope resource ordinal (`r0`, `r1`, …), which is an encounter-order position inside one
 *     scope and therefore carries no information about the value it stands for.
 *
 * Ordinal semantics (`scopeId` + refs) — the load-bearing property for every consumer:
 *   - `scopeId` is the first call event id a capture observes for the session/capture epoch. It names
 *     the scope, and it is not proof of uniqueness: a full replay re-observes the same sequence and is
 *     required to reconstruct the same scope id AND the same ordinal map, byte for byte. A capture
 *     that starts (or resumes) at a later call — including a restart that lost local state — observes a
 *     different first call, so it gets a different scope and ordinals that were never shared with the
 *     earlier epoch.
 *   - refs are allocated per scope in first-observed order over a single namespace shared by `reads`,
 *     `writes` and `inputs`. EQUAL private resource values produce EQUAL refs and DIFFERENT values
 *     produce DIFFERENT refs, so "the issue this episode read is the issue it wrote" is decidable
 *     from refs alone, without the cloud ever learning which issue, path or value it was.
 *   - a ref never crosses a scope: consuming a carrier outside its scope id (for example merging two
 *     sessions, or an epoch before and after a restart) is invalid by construction.
 *
 * Observation semantics: a carrier is attached to the call event as `pending` and to the matching
 * later result event as `success` or `failure`. Only a completed carrier may carry a
 * `resultEventId`, and only a `success` carrier is dataflow evidence: a parse failure, an
 * unresolved resource, an errored call or a call whose outcome is not observable omits evidence
 * instead of guessing. `status` is asserted by the producer from the *actual* observed outcome
 * (nonzero exit code, error status, traceback), never from a harness `isError: false` alone.
 *
 * Canonical form: `reads`, `writes` and `inputs` are deduplicated by ref/name in first-observed
 * order, a ref keeps one resource kind across the whole carrier, and every input ref also appears in
 * `reads` or `writes` (an input is a role over a declared resource, never a resource of its own).
 */

/** Frozen version of the tool link carrier. */
export const TOOL_LINK_EVIDENCE_VERSION = 1 as const;

/** Metadata key under which a tool link carrier travels on a normalized session event. */
export const RESIN_TOOL_LINK_EVIDENCE_KEY = "resinToolLinkV1" as const;

/**
 * Pinned contract limits. Exceeding a pinned limit is a rejection, never a silent prefix: a producer
 * that cannot fit emits no carrier (or omits the resource it cannot represent) rather than emitting
 * a truncated one.
 */
export const TOOL_LINK_EVIDENCE_LIMITS = {
  /** Distinct resources declared as read by one invocation. */
  reads: 4,
  /** Distinct resources declared as written by one invocation. */
  writes: 4,
  /** Distinct semantic input roles named by one invocation. */
  inputs: 6,
  /** Distinct content-shape facts recorded for one invocation. */
  contentKinds: 1,
  /** Highest resource ordinal a ref may name; the per-scope namespace is `r0`…`r<maxRefIndex>`. */
  maxRefIndex: 999,
  /** Canonical serialized byte ceiling of one carrier; larger payloads are rejected unparsed. */
  serializedBytes: 8_192,
} as const;

// ============================================================================
// Finite vocabularies
// ============================================================================

/**
 * Declared operation of one invocation. These are semantic operations, not tool names: a consumer
 * groups by data-flow shape and never by the local spelling of a tool or command.
 */
export const TOOL_LINK_OPERATIONS = [
  "github.issue.read",
  "github.issue.update",
  "file.read",
  "file.write",
  "file.transform",
  "command.exec",
] as const;
export type ToolLinkOperation = (typeof TOOL_LINK_OPERATIONS)[number];

/** Kind of one declared resource; the ordinal namespace is shared across all three kinds. */
export const TOOL_LINK_RESOURCE_KINDS = ["file", "github_issue", "value"] as const;
export type ToolLinkResourceKind = (typeof TOOL_LINK_RESOURCE_KINDS)[number];

/**
 * Semantic role of one declared resource. A role is what makes a carrier reusable as evidence for a
 * parameterized job: the roles of the observed invocation are comparable across runs even though the
 * values behind their refs differ.
 */
export const TOOL_LINK_INPUT_NAMES = ["subject", "source", "target", "changes"] as const;
export type ToolLinkInputName = (typeof TOOL_LINK_INPUT_NAMES)[number];

/**
 * Observed SHAPE of content, never its text: `markdown_checklist` means checklist markers were
 * observed, not which items, titles or states they carried.
 */
export const TOOL_LINK_CONTENT_KINDS = ["markdown_checklist"] as const;
export type ToolLinkContentKind = (typeof TOOL_LINK_CONTENT_KINDS)[number];

export const TOOL_LINK_OBSERVATION_STATUSES = ["pending", "success", "failure"] as const;
export type ToolLinkObservationStatus = (typeof TOOL_LINK_OBSERVATION_STATUSES)[number];

// ============================================================================
// Carrier schemas
// ============================================================================

/** Session/capture-local resource ordinal; never a value, a hash of a value or a raw identifier. */
export const ToolLinkResourceRefIdSchema = z
  .string()
  .regex(
    new RegExp(
      `^r(?:0|[1-9][0-9]{0,${String(TOOL_LINK_EVIDENCE_LIMITS.maxRefIndex).length - 1}})$`,
    ),
    "Resource ref must be a bounded 'r<ordinal>' ordinal id",
  )
  .refine(
    (ref) => Number.parseInt(ref.slice(1), 10) <= TOOL_LINK_EVIDENCE_LIMITS.maxRefIndex,
    "Resource ref exceeds the pinned ordinal namespace",
  );
export type ToolLinkResourceRefId = z.infer<typeof ToolLinkResourceRefIdSchema>;

export const ToolLinkResourceRefSchema = z
  .object({
    kind: z.enum(TOOL_LINK_RESOURCE_KINDS),
    ref: ToolLinkResourceRefIdSchema,
  })
  .strict();
export type ToolLinkResourceRef = z.infer<typeof ToolLinkResourceRefSchema>;

export const ToolLinkInputSchema = z
  .object({
    name: z.enum(TOOL_LINK_INPUT_NAMES),
    ref: ToolLinkResourceRefIdSchema,
  })
  .strict();
export type ToolLinkInput = z.infer<typeof ToolLinkInputSchema>;

/**
 * Observation record. `pending` is the call-side carrier and never carries a `resultEventId`;
 * `success`/`failure` are the result-side carrier and always do. A self-contained invocation whose
 * call and outcome are observed in one event (for example a `command_exec` record) reports the same
 * event id for both roles, which is legal: the carrier still states that the outcome was observed.
 */
export const ToolLinkObservationSchema = z
  .object({
    callId: IdentifierSchema,
    callEventId: IdentifierSchema,
    resultEventId: IdentifierSchema.optional(),
    status: z.enum(TOOL_LINK_OBSERVATION_STATUSES),
  })
  .strict()
  .superRefine((observation, ctx) => {
    if (observation.status === "pending" && observation.resultEventId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultEventId"],
        message: "A pending observation is call-side only and cannot carry a result event id",
      });
    }
    if (observation.status !== "pending" && observation.resultEventId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultEventId"],
        message: "A completed observation must name the result event that carried the outcome",
      });
    }
  });
export type ToolLinkObservation = z.infer<typeof ToolLinkObservationSchema>;

const ToolLinkReadsSchema = z.array(ToolLinkResourceRefSchema).max(TOOL_LINK_EVIDENCE_LIMITS.reads);
const ToolLinkWritesSchema = z
  .array(ToolLinkResourceRefSchema)
  .max(TOOL_LINK_EVIDENCE_LIMITS.writes);
const ToolLinkInputsSchema = z.array(ToolLinkInputSchema).max(TOOL_LINK_EVIDENCE_LIMITS.inputs);
const ToolLinkContentKindsSchema = z
  .array(z.enum(TOOL_LINK_CONTENT_KINDS))
  .max(TOOL_LINK_EVIDENCE_LIMITS.contentKinds);

/**
 * Structural consistency of one carrier, independent of Zod strictness. Runs on every parse, so a
 * tampered or hand-assembled carrier that names dangling inputs, reuses one ordinal for two values,
 * or claims an operation its own reads/writes contradict is rejected rather than interpreted.
 */
function checkCarrierStructure(
  carrier: {
    operation: ToolLinkOperation;
    reads: readonly ToolLinkResourceRef[];
    writes: readonly ToolLinkResourceRef[];
    inputs: readonly ToolLinkInput[];
    contentKinds: readonly ToolLinkContentKind[];
  },
  ctx: z.RefinementCtx,
): void {
  // A ref is a resource identity, so it may appear once per field and must keep one kind everywhere.
  const declared: readonly ToolLinkResourceRef[] = [...carrier.reads, ...carrier.writes];
  const fields: ReadonlyArray<readonly [string, readonly ToolLinkResourceRef[]]> = [
    ["reads", carrier.reads],
    ["writes", carrier.writes],
  ];
  for (const [field, refs] of fields) {
    for (let index = 0; index < refs.length; index++) {
      const entry = refs[index]!;
      if (refs.findIndex((other) => other.ref === entry.ref) !== index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, "ref"],
          message: `${field} must be deduplicated by ref`,
        });
        continue;
      }
      if (declared.some((other) => other.ref === entry.ref && other.kind !== entry.kind)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, index, "kind"],
          message: "One ref names exactly one resource kind within a carrier",
        });
      }
    }
  }

  for (let index = 0; index < carrier.inputs.length; index++) {
    const entry = carrier.inputs[index]!;
    if (carrier.inputs.findIndex((other) => other.name === entry.name) !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs", index, "name"],
        message: "inputs must be deduplicated by name",
      });
    }
    if (!declared.some((resource) => resource.ref === entry.ref)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs", index, "ref"],
        message: "An input role must reference a resource this carrier declares as read or written",
      });
    }
  }

  for (let index = 0; index < carrier.contentKinds.length; index++) {
    const kind = carrier.contentKinds[index]!;
    if (carrier.contentKinds.indexOf(kind) !== index) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["contentKinds", index],
        message: "contentKinds must be deduplicated",
      });
    }
  }

  const readKinds = carrier.reads.map((entry) => entry.kind);
  const writeKinds = carrier.writes.map((entry) => entry.kind);
  const hasRead = carrier.reads.length > 0;
  const hasWrite = carrier.writes.length > 0;

  if (!hasRead && !hasWrite) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reads"],
      message: "A carrier states a declared data flow and needs at least one resource",
    });
  }

  switch (carrier.operation) {
    case "file.read":
      if (hasWrite) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["writes"],
          message: "file.read declares no written resource",
        });
      }
      break;
    case "file.write":
      if (hasRead) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reads"],
          message: "file.write declares no read resource",
        });
      }
      break;
    case "file.transform":
      if (!hasRead || !hasWrite) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reads"],
          message: "file.transform consumes a read resource and produces a written one",
        });
      }
      break;
    case "github.issue.read":
      if (!readKinds.includes("github_issue")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reads"],
          message: "github.issue.read reads at least one issue",
        });
      }
      if (writeKinds.includes("github_issue")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["writes"],
          message: "github.issue.read never writes an issue",
        });
      }
      break;
    case "github.issue.update":
      if (!writeKinds.includes("github_issue")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["writes"],
          message: "github.issue.update writes at least one issue",
        });
      }
      if (readKinds.includes("github_issue")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reads"],
          message: "github.issue.update never reads the issue it writes",
        });
      }
      break;
    case "command.exec":
      break;
  }
}

export const ToolLinkEvidenceV1Schema = z
  .object({
    version: z.literal(TOOL_LINK_EVIDENCE_VERSION),
    scopeId: IdentifierSchema,
    operation: z.enum(TOOL_LINK_OPERATIONS),
    reads: ToolLinkReadsSchema,
    writes: ToolLinkWritesSchema,
    inputs: ToolLinkInputsSchema,
    contentKinds: ToolLinkContentKindsSchema,
    observation: ToolLinkObservationSchema,
  })
  .strict()
  .superRefine((carrier, ctx) => {
    checkCarrierStructure(carrier, ctx);
  });

export type ToolLinkEvidenceV1 = z.infer<typeof ToolLinkEvidenceV1Schema>;

// ============================================================================
// Fail-closed reader
// ============================================================================

/**
 * Fail-closed reader for untrusted metadata carriers.
 *
 * The value is re-serialized with descriptor-only property access (no getter is ever invoked, no
 * prototype-bearing or circular object is accepted), bounded in bytes, then parsed with the strict
 * schema plus the structural carrier checks. Anything that does not survive all three is `undefined`:
 * a consumer never "repairs" a malformed carrier, and no unvalidated field of an untrusted payload
 * can ride along into projection, storage or recognition.
 */
export function readToolLinkEvidence(value: unknown): ToolLinkEvidenceV1 | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const serialized = descriptorSafeCanonicalJsonStringify(value, { maxDepth: 8, maxNodes: 256 });
  if (serialized === undefined) {
    return undefined;
  }
  if (Buffer.byteLength(serialized, "utf8") > TOOL_LINK_EVIDENCE_LIMITS.serializedBytes) {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  const parsed = ToolLinkEvidenceV1Schema.safeParse(decoded);
  return parsed.success ? parsed.data : undefined;
}
