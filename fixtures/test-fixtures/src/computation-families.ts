/**
 * Synthetic native-shaped OMP fixture families for computation capture.
 *
 * Four ordinary agent-authored procedures over plain toy JSON data:
 *
 *   1. `record-join-lineage`        python  multi-hop record/owner join, revision-like child rows
 *                                           excluded, missing links reported
 *   2. `record-schema-order`        js      offline record schema + timestamp-order validation
 *   3. `process-snapshot-ownership` python  ownership attribution by normalised Windows/POSIX
 *                                           executable and exact worktree/cgroup identity
 *   4. `cpu-pss-delta`              js      two-snapshot CPU tick / PSS delta with start-identity
 *                                           guard and unknown (never zeroed) missing fields
 *
 * Every record is a native OMP transcript line: a session line, assistant messages whose
 * `content[]` carries `toolCall` blocks, and `tool_execution_start` / `tool_execution_end`
 * envelopes carrying the tool result. Tool arguments live in the assistant toolCall block;
 * the execution-start envelope carries identity only, exactly like the truncated OMP starts
 * the adapter resolves from its assistant tool-call cache. Tool names are limited to the
 * native `eval` / `read` / `write` / `bash` surface.
 *
 * These fixtures are DATA. They deliberately attach no computation IR, no classification,
 * no digest and no telemetry reader; the real producer must derive all of that from the
 * records. Inputs are plain toy JSON snapshots and record files: no `/proc`, no OS or cloud
 * access, no secrets, no historical records. Canary tokens are planted in inputs so that
 * tests can prove expected outputs never leak them.
 *
 * Each `expected` output was authored independently from the source program (hand-derived
 * from the documented rules of the family) so that executing a program later is a real
 * check instead of a self-fulfilling oracle.
 */

// ============================================================================
// Native OMP record shapes
// ============================================================================

export type ComputationFixtureLanguage = "python" | "javascript";

export type OmpFixtureToolName = "eval" | "read" | "write" | "bash";

export interface OmpFixtureTextBlock {
  type: "text";
  text: string;
}

export interface OmpFixtureEvalArguments {
  language: ComputationFixtureLanguage;
  code: string;
}

export interface OmpFixtureReadArguments {
  path: string;
}

export interface OmpFixtureWriteArguments {
  path: string;
  content: string;
}

export interface OmpFixtureBashArguments {
  command: string;
}

export type OmpFixtureToolArguments =
  | OmpFixtureEvalArguments
  | OmpFixtureReadArguments
  | OmpFixtureWriteArguments
  | OmpFixtureBashArguments;

export interface OmpFixtureToolCallBlock {
  type: "toolCall";
  id: string;
  name: OmpFixtureToolName;
  arguments: OmpFixtureToolArguments;
}

export interface OmpFixtureSessionRecord {
  type: "session";
  id: string;
  sessionId: string;
  timestamp: string;
  workspace: string;
}

export interface OmpFixtureAssistantMessageRecord {
  type: "message";
  role: "assistant";
  sessionId: string;
  timestamp: string;
  model: string;
  content: Array<OmpFixtureTextBlock | OmpFixtureToolCallBlock>;
}

export interface OmpFixtureToolExecutionStartRecord {
  type: "custom";
  customType: "tool_execution_start";
  sessionId: string;
  timestamp: string;
  data: {
    toolCallId: string;
    toolName: OmpFixtureToolName;
  };
}

export interface OmpFixtureToolExecutionEndRecord {
  type: "custom";
  customType: "tool_execution_end";
  sessionId: string;
  timestamp: string;
  data: {
    toolCallId: string;
    toolName: OmpFixtureToolName;
    result: string;
    isError: boolean;
  };
}

export type OmpFixtureRecord =
  | OmpFixtureSessionRecord
  | OmpFixtureAssistantMessageRecord
  | OmpFixtureToolExecutionStartRecord
  | OmpFixtureToolExecutionEndRecord;

export interface CollectedOmpFixtureToolCall {
  callId: string;
  toolName: OmpFixtureToolName;
  toolArguments: OmpFixtureToolArguments;
  timestamp: string;
}

export interface CollectedOmpFixtureToolResult {
  callId: string;
  toolName: OmpFixtureToolName;
  result: string;
  isError: boolean;
  timestamp: string;
}

// ============================================================================
// Fixture family shapes
// ============================================================================

export interface ComputationFixtureRunnable {
  language: ComputationFixtureLanguage;
  /** Shell command to run inside a directory holding `files`. */
  command: string;
  /** Relative path -> exact file content. */
  files: Record<string, string>;
}

export interface ComputationFixtureExpectedOutput {
  stdout: string;
  parsed: unknown;
  runnable: ComputationFixtureRunnable;
}

export interface ComputationFixtureSupersededOutput extends ComputationFixtureExpectedOutput {
  invocationCallId: string;
}

export interface ComputationFixtureDataset {
  datasetId: string;
  kind: "primary" | "negative";
  summary: string;
  /** Plain toy JSON input consumed by the procedure. */
  input: unknown;
  /** Canary tokens planted in the input and required to be absent from outputs. */
  canaries: string[];
  invocationCallId: string;
  expected: ComputationFixtureExpectedOutput;
  /** Present only for corrected-helper variants: the earlier, wrong observation. */
  superseded?: ComputationFixtureSupersededOutput;
}

export type ComputationFixtureVariantKind =
  | "definition-use"
  | "corrected-helper"
  | "file-write-then-execute";

export interface ComputationFixtureVariant {
  variantId: string;
  familyId: string;
  kind: ComputationFixtureVariantKind;
  sessionId: string;
  language: ComputationFixtureLanguage;
  summary: string;
  records: OmpFixtureRecord[];
  datasets: ComputationFixtureDataset[];
  /** Helper source reused verbatim by another family's procedure. */
  sharedHelperSource?: string;
  /** Earlier definition replaced by the corrected source in the same variant. */
  supersededDefinitionSource?: string;
}

export interface ComputationFixtureFamily {
  familyId: string;
  language: ComputationFixtureLanguage;
  summary: string;
  negativeCase: string;
  canaries: string[];
  variants: ComputationFixtureVariant[];
}

export interface ComputationFixtureClock {
  next(): string;
}

// ============================================================================
// Deterministic helpers
// ============================================================================

export const COMPUTATION_FIXTURE_MODEL = "synthetic-fixture-model-v1";

/**
 * Canonical compact JSON: recursively sorted object keys, no whitespace.
 * Mirrors `json.dumps(value, sort_keys=True, separators=(",", ":"))` in Python and the
 * `stableStringify` helper embedded in the JavaScript procedures.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** Deterministic, strictly increasing ISO timestamps for one synthetic session. */
export function createComputationFixtureClock(
  baseIso: string,
  stepSeconds = 2,
): ComputationFixtureClock {
  let cursor = Date.parse(baseIso);
  return {
    next(): string {
      const timestamp = new Date(cursor).toISOString();
      cursor += stepSeconds * 1000;
      return timestamp;
    },
  };
}

export function buildOmpFixtureSessionRecord(
  sessionId: string,
  timestamp: string,
  workspace: string,
): OmpFixtureSessionRecord {
  return { type: "session", id: sessionId, sessionId, timestamp, workspace };
}

export function buildOmpFixtureAssistantToolCall(options: {
  sessionId: string;
  timestamp: string;
  callId: string;
  toolName: OmpFixtureToolName;
  toolArguments: OmpFixtureToolArguments;
  text: string;
}): OmpFixtureAssistantMessageRecord {
  return {
    type: "message",
    role: "assistant",
    sessionId: options.sessionId,
    timestamp: options.timestamp,
    model: COMPUTATION_FIXTURE_MODEL,
    content: [
      { type: "text", text: options.text },
      {
        type: "toolCall",
        id: options.callId,
        name: options.toolName,
        arguments: options.toolArguments,
      },
    ],
  };
}

/** Start envelope carries identity only; arguments stay in the assistant toolCall block. */
export function buildOmpFixtureToolExecutionStart(options: {
  sessionId: string;
  timestamp: string;
  callId: string;
  toolName: OmpFixtureToolName;
}): OmpFixtureToolExecutionStartRecord {
  return {
    type: "custom",
    customType: "tool_execution_start",
    sessionId: options.sessionId,
    timestamp: options.timestamp,
    data: { toolCallId: options.callId, toolName: options.toolName },
  };
}

export function buildOmpFixtureToolExecutionEnd(options: {
  sessionId: string;
  timestamp: string;
  callId: string;
  toolName: OmpFixtureToolName;
  result: string;
  isError?: boolean;
}): OmpFixtureToolExecutionEndRecord {
  return {
    type: "custom",
    customType: "tool_execution_end",
    sessionId: options.sessionId,
    timestamp: options.timestamp,
    data: {
      toolCallId: options.callId,
      toolName: options.toolName,
      result: options.result,
      isError: options.isError ?? false,
    },
  };
}

/** One assistant toolCall turn plus its start/result envelopes, timestamped in order. */
export function buildOmpFixtureToolTurn(options: {
  sessionId: string;
  clock: ComputationFixtureClock;
  callId: string;
  toolName: OmpFixtureToolName;
  toolArguments: OmpFixtureToolArguments;
  intent: string;
  result: string;
}): OmpFixtureRecord[] {
  return [
    buildOmpFixtureAssistantToolCall({
      sessionId: options.sessionId,
      timestamp: options.clock.next(),
      callId: options.callId,
      toolName: options.toolName,
      toolArguments: options.toolArguments,
      text: options.intent,
    }),
    buildOmpFixtureToolExecutionStart({
      sessionId: options.sessionId,
      timestamp: options.clock.next(),
      callId: options.callId,
      toolName: options.toolName,
    }),
    buildOmpFixtureToolExecutionEnd({
      sessionId: options.sessionId,
      timestamp: options.clock.next(),
      callId: options.callId,
      toolName: options.toolName,
      result: options.result,
    }),
  ];
}

export function collectOmpFixtureToolCalls(
  records: OmpFixtureRecord[],
): CollectedOmpFixtureToolCall[] {
  const calls: CollectedOmpFixtureToolCall[] = [];
  for (const record of records) {
    if (record.type !== "message") continue;
    for (const block of record.content) {
      if (block.type !== "toolCall") continue;
      calls.push({
        callId: block.id,
        toolName: block.name,
        toolArguments: block.arguments,
        timestamp: record.timestamp,
      });
    }
  }
  return calls;
}

export function collectOmpFixtureToolResults(
  records: OmpFixtureRecord[],
): CollectedOmpFixtureToolResult[] {
  const results: CollectedOmpFixtureToolResult[] = [];
  for (const record of records) {
    if (record.type !== "custom" || record.customType !== "tool_execution_end") continue;
    results.push({
      callId: record.data.toolCallId,
      toolName: record.data.toolName,
      result: record.data.result,
      isError: record.data.isError,
      timestamp: record.timestamp,
    });
  }
  return results;
}

/** JSON string literal, valid in both JavaScript and Python source. */
function pythonUseCell(datasetJson: string, expression: string): string {
  return [
    "import json as _json",
    "",
    `_DATA = _json.loads(${JSON.stringify(datasetJson)})`,
    "",
    "",
    "def _emit(value):",
    '    print(_json.dumps(value, sort_keys=True, separators=(",", ":")))',
    "",
    "",
    `_emit(${expression})`,
    "",
  ].join("\n");
}

function javascriptUseCell(datasetJson: string, expression: string): string {
  return [
    `const DATASET_TEXT = ${JSON.stringify(datasetJson)};`,
    'const DATASET = parseJsonText(DATASET_TEXT, "dataset.json");',
    `console.log(stableStringify(${expression}));`,
    "",
  ].join("\n");
}

function expectedOutput(
  parsed: unknown,
  runnable: ComputationFixtureRunnable,
): ComputationFixtureExpectedOutput {
  return { stdout: canonicalJson(parsed), parsed, runnable };
}

function combinedRunnable(
  language: ComputationFixtureLanguage,
  definitionSource: string,
  useCell: string,
): ComputationFixtureRunnable {
  return language === "python"
    ? {
        language,
        command: "python3 main.py",
        files: { "main.py": `${definitionSource}\n\n${useCell}` },
      }
    : {
        language,
        command: "node main.mjs",
        files: { "main.mjs": `${definitionSource}\n\n${useCell}` },
      };
}

// ============================================================================
// Shared JavaScript helper (reused verbatim by two procedure families)
// ============================================================================

/**
 * Record I/O helper authored once and reused by `record-schema-order` (written to
 * `tools/record-io.mjs` and imported by its validation script) and by `cpu-pss-delta`
 * (defined inline in its definition cell). Both procedures embed this exact text, which
 * is what makes independent reuse of one helper observable to the pipeline.
 */
export const SHARED_RECORD_IO_HELPER_SOURCE = [
  "function parseJsonText(text, label) {",
  "  try {",
  "    return JSON.parse(text);",
  "  } catch (error) {",
  '    throw new Error(label + ": invalid JSON (" + error.message + ")");',
  "  }",
  "}",
  "",
  "function parseRecordArray(text, label) {",
  "  const value = parseJsonText(text, label);",
  "  if (!Array.isArray(value)) {",
  '    throw new Error(label + ": expected a JSON array");',
  "  }",
  "  return value;",
  "}",
  "",
  "function stableStringify(value) {",
  "  if (Array.isArray(value)) {",
  '    return "[" + value.map((item) => stableStringify(item)).join(",") + "]";',
  "  }",
  '  if (value !== null && typeof value === "object") {',
  "    const keys = Object.keys(value).sort();",
  '    return (\n      "{" +\n      keys\n        .map((key) => JSON.stringify(key) + ":" + stableStringify(value[key]))\n        .join(",") +\n      "}"\n    );',
  "  }",
  "  return JSON.stringify(value);",
  "}",
].join("\n");

// ============================================================================
// Canaries
// ============================================================================

const CANARY = {
  joinSignatureA: "CANARY_JOIN_SIGNATURE_7f31",
  joinOwnerKeyA: "CANARY_OWNER_KEY_2c58",
  joinChildB: "CANARY_JOIN_CHILD_9d24",
  joinOwnerKeyB: "CANARY_OWNER_KEY_4a17",
  childRowKeyA: "CANARY_CHILD_ROW_8e70",
  childRowKeyB: "CANARY_CHILD_ROW_1f36",
  teamSecretA: "CANARY_TEAM_SECRET_6a02",
  teamSecretB: "CANARY_TEAM_SECRET_3c97",
  recordTokenA: "CANARY_RECORD_TOKEN_5c11",
  recordTokenB: "CANARY_RECORD_TOKEN_8b02",
  envTokenA: "CANARY_ENV_TOKEN_3d90",
  secretKeyA: "CANARY_SECRET_KEY_7f21",
  cmdlineTokenA: "CANARY_CMDLINE_TOKEN_2b8e",
  envTokenB: "CANARY_ENV_TOKEN_6e43",
  envTokenC: "CANARY_ENV_TOKEN_b145",
  cmdlineTokenB: "CANARY_CMDLINE_TOKEN_1a77",
  cpuCmdlineA: "CANARY_CMDLINE_KEY_4d55",
  cpuCmdlineB: "CANARY_CMDLINE_KEY_9c31",
} as const;

// ============================================================================
// Family 1 - python multi-hop record join (definition-use + corrected helper)
// ============================================================================

const JOIN_HELPER_V1_SOURCE = [
  "def join_records(records, owners, teams):",
  "    by_owner = {}",
  "    for owner in owners:",
  '        by_owner[owner["ownerId"]] = owner',
  "    joined = []",
  "    missing_owners = []",
  "    for record in records:",
  '        owner = by_owner.get(record["ownerRef"])',
  "        if owner is None:",
  '            missing_owners.append(record["recordId"])',
  "            continue",
  "        joined.append({",
  '            "recordId": record["recordId"],',
  '            "owner": owner["name"],',
  '            "team": owner.get("team"),',
  '            "costCenter": owner.get("costCenter"),',
  '            "kind": record["kind"],',
  '            "parentId": record["parentId"],',
  "        })",
  '    return {"joined": joined, "missingOwners": missing_owners}',
].join("\n");

const JOIN_HELPER_V2_SOURCE = [
  'CHILD_KINDS = ("child", "child_row")',
  'REVISION_KINDS = ("revision", "revision_row", "rev")',
  "",
  "",
  "def join_records(records, owners, teams):",
  "    by_owner = {}",
  "    for owner in owners:",
  '        by_owner[owner["ownerId"]] = owner',
  "    by_team = {}",
  "    for team in teams:",
  '        by_team[team["teamId"]] = team',
  "    known_records = set()",
  "    for record in records:",
  '        known_records.add(record["recordId"])',
  "    joined = []",
  "    missing_owners = []",
  "    missing_teams = []",
  "    missing_parents = []",
  "    excluded_child = []",
  "    excluded_revision = []",
  "    for record in records:",
  '        kind = record["kind"]',
  "        if kind in CHILD_KINDS:",
  '            excluded_child.append(record["recordId"])',
  "            continue",
  "        if kind in REVISION_KINDS:",
  '            excluded_revision.append(record["recordId"])',
  "            continue",
  '        owner = by_owner.get(record["ownerRef"])',
  "        if owner is None:",
  '            missing_owners.append(record["recordId"])',
  "        else:",
  '            team = by_team.get(owner["teamRef"])',
  "            if team is None:",
  '                missing_teams.append(record["recordId"])',
  "            joined.append({",
  '                "recordId": record["recordId"],',
  '                "owner": owner["name"],',
  '                "team": team["name"] if team is not None else None,',
  '                "costCenter": team["costCenter"] if team is not None else None,',
  '                "kind": kind,',
  '                "parentId": record["parentId"],',
  "            })",
  '        parent_id = record["parentId"]',
  "        if parent_id is not None and parent_id not in known_records:",
  '            missing_parents.append(record["recordId"])',
  "    return {",
  '        "joined": joined,',
  '        "missingOwners": missing_owners,',
  '        "missingTeams": missing_teams,',
  '        "missingParents": missing_parents,',
  '        "excludedChildRows": excluded_child,',
  '        "excludedRevisionRows": excluded_revision,',
  "    }",
].join("\n");

const JOIN_USE_EXPRESSION = 'join_records(_DATA["records"], _DATA["owners"], _DATA["teams"])';

const JOIN_INPUT_A = {
  records: [
    { recordId: "r-1001", parentId: "r-1000", kind: "record", ownerRef: "own-1" },
    { recordId: "r-1002", parentId: "r-1001", kind: "record", ownerRef: "own-2" },
    { recordId: "r-1003", parentId: "r-1001", kind: "revision", ownerRef: "own-1" },
    { recordId: "r-1004", parentId: "r-9999", kind: "record", ownerRef: "own-3" },
    { recordId: "r-1005", parentId: "r-1002", kind: "record", ownerRef: "own-404" },
    {
      recordId: "r-1006",
      parentId: null,
      kind: "record",
      ownerRef: "own-3",
      signature: CANARY.joinSignatureA,
    },
    { recordId: "r-1007", parentId: "r-1006", kind: "revision_row", ownerRef: "own-2" },
    {
      recordId: "r-1008",
      parentId: "r-1002",
      kind: "child",
      ownerRef: "own-2",
      signature: CANARY.childRowKeyA,
    },
    { recordId: "r-1009", parentId: "r-1002", kind: "child_row", ownerRef: "own-1" },
  ],
  owners: [
    { ownerId: "own-1", name: "north", teamRef: "t-platform" },
    { ownerId: "own-2", name: "south", teamRef: "t-data" },
    { ownerId: "own-3", name: "east", teamRef: "t-missing", apiKey: CANARY.joinOwnerKeyA },
    { ownerId: "own-4", name: "west", teamRef: "t-platform" },
  ],
  teams: [
    { teamId: "t-platform", name: "Platform", costCenter: "cc-100", apiToken: CANARY.teamSecretA },
    { teamId: "t-data", name: "Data", costCenter: "cc-200" },
  ],
};

const JOIN_INPUT_B = {
  records: [
    { recordId: "r-2001", parentId: null, kind: "record", ownerRef: "own-9" },
    { recordId: "r-2002", parentId: "r-2001", kind: "revision", ownerRef: "own-9" },
    { recordId: "r-2003", parentId: "r-2002", kind: "record", ownerRef: "own-8" },
    { recordId: "r-2004", parentId: "r-2003", kind: "record", ownerRef: "own-7" },
    {
      recordId: "r-2005",
      parentId: "r-2077",
      kind: "record",
      ownerRef: "own-9",
      signature: CANARY.joinChildB,
    },
    { recordId: "r-2006", parentId: "r-2003", kind: "child", ownerRef: "own-8" },
    {
      recordId: "r-2007",
      parentId: "r-2001",
      kind: "child_row",
      ownerRef: "own-9",
      signature: CANARY.childRowKeyB,
    },
  ],
  owners: [
    { ownerId: "own-8", name: "west", teamRef: "t-core" },
    { ownerId: "own-9", name: "north", teamRef: "t-gone", apiKey: CANARY.joinOwnerKeyB },
  ],
  teams: [{ teamId: "t-core", name: "Core", costCenter: "cc-300", apiToken: CANARY.teamSecretB }],
};

const JOIN_EXPECTED_A = {
  joined: [
    {
      recordId: "r-1001",
      owner: "north",
      team: "Platform",
      costCenter: "cc-100",
      kind: "record",
      parentId: "r-1000",
    },
    {
      recordId: "r-1002",
      owner: "south",
      team: "Data",
      costCenter: "cc-200",
      kind: "record",
      parentId: "r-1001",
    },
    {
      recordId: "r-1004",
      owner: "east",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-9999",
    },
    {
      recordId: "r-1006",
      owner: "east",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: null,
    },
  ],
  missingOwners: ["r-1005"],
  missingTeams: ["r-1004", "r-1006"],
  missingParents: ["r-1001", "r-1004"],
  excludedChildRows: ["r-1008", "r-1009"],
  excludedRevisionRows: ["r-1003", "r-1007"],
};

const JOIN_EXPECTED_A_V1 = {
  joined: [
    {
      recordId: "r-1001",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-1000",
    },
    {
      recordId: "r-1002",
      owner: "south",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-1001",
    },
    {
      recordId: "r-1003",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "revision",
      parentId: "r-1001",
    },
    {
      recordId: "r-1004",
      owner: "east",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-9999",
    },
    {
      recordId: "r-1006",
      owner: "east",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: null,
    },
    {
      recordId: "r-1007",
      owner: "south",
      team: null,
      costCenter: null,
      kind: "revision_row",
      parentId: "r-1006",
    },
    {
      recordId: "r-1008",
      owner: "south",
      team: null,
      costCenter: null,
      kind: "child",
      parentId: "r-1002",
    },
    {
      recordId: "r-1009",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "child_row",
      parentId: "r-1002",
    },
  ],
  missingOwners: ["r-1005"],
};

const JOIN_EXPECTED_B = {
  joined: [
    {
      recordId: "r-2001",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: null,
    },
    {
      recordId: "r-2003",
      owner: "west",
      team: "Core",
      costCenter: "cc-300",
      kind: "record",
      parentId: "r-2002",
    },
    {
      recordId: "r-2005",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-2077",
    },
  ],
  missingOwners: ["r-2004"],
  missingTeams: ["r-2001", "r-2005"],
  missingParents: ["r-2005"],
  excludedChildRows: ["r-2006", "r-2007"],
  excludedRevisionRows: ["r-2002"],
};

const JOIN_EXPECTED_B_V1 = {
  joined: [
    {
      recordId: "r-2001",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: null,
    },
    {
      recordId: "r-2002",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "revision",
      parentId: "r-2001",
    },
    {
      recordId: "r-2003",
      owner: "west",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-2002",
    },
    {
      recordId: "r-2005",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "record",
      parentId: "r-2077",
    },
    {
      recordId: "r-2006",
      owner: "west",
      team: null,
      costCenter: null,
      kind: "child",
      parentId: "r-2003",
    },
    {
      recordId: "r-2007",
      owner: "north",
      team: null,
      costCenter: null,
      kind: "child_row",
      parentId: "r-2001",
    },
  ],
  missingOwners: ["r-2004"],
};

export function buildRecordJoinFamily(): ComputationFixtureFamily {
  const sessionId = "omp-fixture-join-session";
  const clock = createComputationFixtureClock("2026-06-01T09:00:00.000Z");
  const useCellA = pythonUseCell(canonicalJson(JOIN_INPUT_A), JOIN_USE_EXPRESSION);
  const useCellB = pythonUseCell(canonicalJson(JOIN_INPUT_B), JOIN_USE_EXPRESSION);

  const records: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(sessionId, clock.next(), "/workspace/fixture-join"),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-def-v1",
      toolName: "eval",
      toolArguments: { language: "python", code: JOIN_HELPER_V1_SOURCE },
      intent: "Define a first pass at the record/owner join.",
      result: "",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-use-a-v1",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellA },
      intent: "Join the first record set with the first-pass helper.",
      result: canonicalJson(JOIN_EXPECTED_A_V1),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-use-b-v1",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellB },
      intent: "Join the second record set with the first-pass helper.",
      result: canonicalJson(JOIN_EXPECTED_B_V1),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-def-v2",
      toolName: "eval",
      toolArguments: { language: "python", code: JOIN_HELPER_V2_SOURCE },
      intent:
        "Rewrite the join so revision-like child rows are dropped and missing links reported.",
      result: "",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-use-a-v2",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellA },
      intent: "Re-run the first record set against the corrected join.",
      result: canonicalJson(JOIN_EXPECTED_A),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-join-use-b-v2",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellB },
      intent: "Re-run the second record set against the corrected join.",
      result: canonicalJson(JOIN_EXPECTED_B),
    }),
  ];

  return {
    familyId: "record-join-lineage",
    language: "python",
    summary:
      "Three-hop record -> owner -> team join over plain JSON relations, excluding child and " +
      "revision-like rows and reporting missing owner, team and parent links.",
    negativeCase: "missing-joins",
    canaries: [
      CANARY.joinSignatureA,
      CANARY.joinOwnerKeyA,
      CANARY.joinChildB,
      CANARY.joinOwnerKeyB,
      CANARY.childRowKeyA,
      CANARY.childRowKeyB,
      CANARY.teamSecretA,
      CANARY.teamSecretB,
    ],
    variants: [
      {
        variantId: "record-join-corrected-helper",
        familyId: "record-join-lineage",
        kind: "corrected-helper",
        sessionId,
        language: "python",
        summary:
          "Definition cell, two separate use cells, then a corrected definition and the same two " +
          "use cells again; the earlier observation stays recorded as superseded.",
        records,
        supersededDefinitionSource: JOIN_HELPER_V1_SOURCE,
        datasets: [
          {
            datasetId: "join-records-a",
            kind: "primary",
            summary:
              "Seven records, two revision-like rows, one unknown owner, two dangling parents.",
            input: JOIN_INPUT_A,
            canaries: [CANARY.joinSignatureA, CANARY.joinOwnerKeyA],
            invocationCallId: "call-join-use-a-v2",
            expected: expectedOutput(
              JOIN_EXPECTED_A,
              combinedRunnable("python", JOIN_HELPER_V2_SOURCE, useCellA),
            ),
            superseded: {
              invocationCallId: "call-join-use-a-v1",
              ...expectedOutput(
                JOIN_EXPECTED_A_V1,
                combinedRunnable("python", JOIN_HELPER_V1_SOURCE, useCellA),
              ),
            },
          },
          {
            datasetId: "join-records-b",
            kind: "negative",
            summary:
              "Revision row carrying a valid parent link, one unknown owner, one dangling parent.",
            input: JOIN_INPUT_B,
            canaries: [CANARY.joinChildB, CANARY.joinOwnerKeyB],
            invocationCallId: "call-join-use-b-v2",
            expected: expectedOutput(
              JOIN_EXPECTED_B,
              combinedRunnable("python", JOIN_HELPER_V2_SOURCE, useCellB),
            ),
            superseded: {
              invocationCallId: "call-join-use-b-v1",
              ...expectedOutput(
                JOIN_EXPECTED_B_V1,
                combinedRunnable("python", JOIN_HELPER_V1_SOURCE, useCellB),
              ),
            },
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Family 2 - javascript schema + timestamp-order validation (file write then execute)
// ============================================================================

const SCHEMA_ORDER_VALIDATOR_SOURCE = [
  'import { readFileSync } from "node:fs";',
  'import { parseRecordArray, stableStringify } from "./record-io.mjs";',
  "",
  'const REQUIRED_FIELDS = ["recordId", "sequence", "createdAt", "kind", "ownerRef"];',
  "",
  "function isValidIsoTimestamp(value) {",
  '  return typeof value === "string" && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value);',
  "}",
  "",
  "function validateRecords(records) {",
  "  const issues = [];",
  "  const valid = [];",
  "  for (const record of records) {",
  '    const label =\n      typeof record.recordId === "string" && record.recordId.length > 0 ? record.recordId : "unknown";',
  "    const before = issues.length;",
  "    for (const field of REQUIRED_FIELDS) {",
  "      if (!(field in record)) {",
  '        issues.push({ recordId: label, code: "missing_field", field: field });',
  "        continue;",
  "      }",
  "      const value = record[field];",
  '      if (field === "sequence") {',
  "        if (!Number.isInteger(value)) {",
  '          issues.push({ recordId: label, code: "invalid_type", field: field });',
  "        }",
  '      } else if (field === "createdAt") {',
  "        if (!isValidIsoTimestamp(value)) {",
  '          issues.push({ recordId: label, code: "invalid_type", field: field });',
  "        }",
  '      } else if (typeof value !== "string" || value.length === 0) {',
  '        issues.push({ recordId: label, code: "invalid_type", field: field });',
  "      }",
  "    }",
  "    if (issues.length === before) {",
  "      valid.push(record);",
  "    }",
  "  }",
  "  const orderViolations = [];",
  "  for (let index = 1; index < valid.length; index += 1) {",
  "    if (valid[index].createdAt < valid[index - 1].createdAt) {",
  "      orderViolations.push({",
  "        recordId: valid[index].recordId,",
  "        afterRecordId: valid[index - 1].recordId,",
  "      });",
  "    }",
  "  }",
  "  return {",
  "    recordCount: records.length,",
  "    validCount: valid.length,",
  "    invalidCount: records.length - valid.length,",
  "    issues: issues,",
  "    orderViolations: orderViolations,",
  "  };",
  "}",
  "",
  "const datasetPath = process.argv[2];",
  'const records = parseRecordArray(readFileSync(datasetPath, "utf8"), datasetPath);',
  "console.log(stableStringify(validateRecords(records)));",
].join("\n");

const SCHEMA_ORDER_HELPER_MODULE = `${SHARED_RECORD_IO_HELPER_SOURCE}\n\nexport { parseRecordArray, parseJsonText, stableStringify };\n`;

const SCHEMA_ORDER_INPUT_A = [
  {
    recordId: "rc-01",
    sequence: 1,
    createdAt: "2026-03-01T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-1",
  },
  {
    recordId: "rc-02",
    sequence: 2,
    createdAt: "2026-02-01T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-1",
  },
  {
    recordId: "rc-03",
    sequence: 3,
    createdAt: "2026-03-03T00:00:00.000Z",
    kind: "revision",
    ownerRef: null,
  },
  {
    recordId: "rc-04",
    sequence: "4",
    createdAt: "2026-03-04T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-2",
  },
  {
    recordId: "rc-05",
    sequence: 5,
    createdAt: "2026-03-05T00:00:00.000Z",
    ownerRef: "own-2",
    authToken: CANARY.recordTokenA,
  },
];

const SCHEMA_ORDER_INPUT_B = [
  {
    recordId: "rc-11",
    sequence: 10,
    createdAt: "2026-04-01T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-5",
  },
  {
    recordId: "rc-12",
    sequence: 11,
    createdAt: "2026-04-02T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-5",
    authToken: CANARY.recordTokenB,
  },
  { recordId: "rc-13", sequence: 12, kind: "record", ownerRef: "own-6" },
  {
    recordId: "rc-14",
    sequence: 13,
    createdAt: "2026-04-03T00:00:00.000Z",
    kind: 7,
    ownerRef: "own-6",
  },
  {
    recordId: "rc-15",
    sequence: 14,
    createdAt: "2026-03-31T00:00:00.000Z",
    kind: "record",
    ownerRef: "own-6",
  },
];

const SCHEMA_ORDER_EXPECTED_A = {
  recordCount: 5,
  validCount: 2,
  invalidCount: 3,
  issues: [
    { recordId: "rc-03", code: "invalid_type", field: "ownerRef" },
    { recordId: "rc-04", code: "invalid_type", field: "sequence" },
    { recordId: "rc-05", code: "missing_field", field: "kind" },
  ],
  orderViolations: [{ recordId: "rc-02", afterRecordId: "rc-01" }],
};

const SCHEMA_ORDER_EXPECTED_B = {
  recordCount: 5,
  validCount: 3,
  invalidCount: 2,
  issues: [
    { recordId: "rc-13", code: "missing_field", field: "createdAt" },
    { recordId: "rc-14", code: "invalid_type", field: "kind" },
  ],
  orderViolations: [{ recordId: "rc-15", afterRecordId: "rc-12" }],
};

export function buildRecordSchemaOrderFamily(): ComputationFixtureFamily {
  const sessionId = "omp-fixture-schema-order-session";
  const clock = createComputationFixtureClock("2026-06-01T10:00:00.000Z");
  const datasetPathA = "datasets/validate-a.json";
  const datasetPathB = "datasets/validate-b.json";
  const fileA = `${JSON.stringify(SCHEMA_ORDER_INPUT_A, null, 2)}\n`;
  const fileB = `${JSON.stringify(SCHEMA_ORDER_INPUT_B, null, 2)}\n`;
  const bashCommandA = `node tools/validate-records.mjs ${datasetPathA}`;
  const bashCommandB = `node tools/validate-records.mjs ${datasetPathB}`;

  const records: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(sessionId, clock.next(), "/workspace/fixture-schema-order"),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-write-helper",
      toolName: "write",
      toolArguments: { path: "tools/record-io.mjs", content: SCHEMA_ORDER_HELPER_MODULE },
      intent: "Author the shared JSON record I/O helper as a module.",
      result: "Wrote tools/record-io.mjs",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-write-validator",
      toolName: "write",
      toolArguments: { path: "tools/validate-records.mjs", content: SCHEMA_ORDER_VALIDATOR_SOURCE },
      intent: "Author the offline schema and timestamp-order validator.",
      result: "Wrote tools/validate-records.mjs",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-write-dataset-a",
      toolName: "write",
      toolArguments: { path: datasetPathA, content: fileA },
      intent: "Write the first record dataset.",
      result: `Wrote ${datasetPathA}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-run-a",
      toolName: "bash",
      toolArguments: { command: bashCommandA },
      intent: "Validate the first dataset with the authored script.",
      result: canonicalJson(SCHEMA_ORDER_EXPECTED_A),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-write-dataset-b",
      toolName: "write",
      toolArguments: { path: datasetPathB, content: fileB },
      intent: "Write the second record dataset.",
      result: `Wrote ${datasetPathB}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-read-validator",
      toolName: "read",
      toolArguments: { path: "tools/validate-records.mjs" },
      intent: "Read the authored validator back before running it.",
      result: SCHEMA_ORDER_VALIDATOR_SOURCE,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId,
      clock,
      callId: "call-schema-run-b",
      toolName: "bash",
      toolArguments: { command: bashCommandB },
      intent: "Validate the second dataset with the authored script.",
      result: canonicalJson(SCHEMA_ORDER_EXPECTED_B),
    }),
  ];

  const runnableFor = (datasetPath: string, file: string): ComputationFixtureRunnable => ({
    language: "javascript",
    command: `node tools/validate-records.mjs ${datasetPath}`,
    files: {
      "tools/record-io.mjs": SCHEMA_ORDER_HELPER_MODULE,
      "tools/validate-records.mjs": SCHEMA_ORDER_VALIDATOR_SOURCE,
      [datasetPath]: file,
    },
  });

  return {
    familyId: "record-schema-order",
    language: "javascript",
    summary:
      "Offline validation of a JSON record array: required fields and types, plus timestamp order " +
      "over the schema-valid records.",
    negativeCase: "invalid-order",
    canaries: [CANARY.recordTokenA, CANARY.recordTokenB],
    variants: [
      {
        variantId: "record-schema-order-file-write-then-execute",
        familyId: "record-schema-order",
        kind: "file-write-then-execute",
        sessionId,
        language: "javascript",
        summary:
          "Shared helper module and validator script are written as files, then executed with bash " +
          "once per dataset.",
        records,
        sharedHelperSource: SHARED_RECORD_IO_HELPER_SOURCE,
        datasets: [
          {
            datasetId: "schema-order-a",
            kind: "primary",
            summary:
              "Null owner ref, non-integer sequence, missing kind, one out-of-order timestamp.",
            input: SCHEMA_ORDER_INPUT_A,
            canaries: [CANARY.recordTokenA],
            invocationCallId: "call-schema-run-a",
            expected: expectedOutput(SCHEMA_ORDER_EXPECTED_A, runnableFor(datasetPathA, fileA)),
          },
          {
            datasetId: "schema-order-b",
            kind: "negative",
            summary:
              "Missing createdAt, non-string kind, and a timestamp earlier than its predecessor.",
            input: SCHEMA_ORDER_INPUT_B,
            canaries: [CANARY.recordTokenB],
            invocationCallId: "call-schema-run-b",
            expected: expectedOutput(SCHEMA_ORDER_EXPECTED_B, runnableFor(datasetPathB, fileB)),
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Family 3 - python process-snapshot ownership attribution
// ============================================================================

const OWNERSHIP_HELPER_SOURCE = [
  "def _fold_case(text):",
  '    if text.startswith("//"):',
  "        return text.lower()",
  '    if len(text) >= 2 and text[1] == ":" and text[0].isalpha():',
  "        return text.lower()",
  "    return text",
  "",
  "",
  "def _normalize_path(value):",
  '    text = str(value).replace("\\\\", "/").strip()',
  '    while text.endswith("/") and len(text) > 1:',
  "        text = text[:-1]",
  "    return _fold_case(text)",
  "",
  "",
  "def _argv0(raw):",
  "    if raw is None:",
  '        return ""',
  "    text = str(raw).strip()",
  "    if not text:",
  '        return ""',
  "    if text.startswith('\"'):",
  "        end = text.find('\"', 1)",
  "        if end == -1:",
  "            return text[1:]",
  "        return text[1:end]",
  '    return text.split(" ", 1)[0]',
  "",
  "",
  "def _executable_name(process):",
  '    raw = process.get("cmdline")',
  '    if raw is None or str(raw).strip() == "":',
  '        raw = process.get("executable")',
  "    text = _normalize_path(_argv0(raw))",
  "    if not text:",
  '        return ""',
  '    return text.rsplit("/", 1)[-1].lower()',
  "",
  "",
  "def attribute_owners(snapshot):",
  '    worktrees = snapshot["worktrees"]',
  '    processes = snapshot["processes"]',
  "    by_pid = {}",
  "    for process in processes:",
  '        by_pid.setdefault(process["pid"], []).append(process)',
  "    pid_reused = []",
  "    for pid in sorted(by_pid):",
  "        tokens = set()",
  "        for process in by_pid[pid]:",
  '            tokens.add(str(process.get("startToken")))',
  "        if len(tokens) > 1:",
  "            pid_reused.append(pid)",
  "    reused = set(pid_reused)",
  "    attributed = []",
  "    skipped = []",
  "    for process in processes:",
  '        pid = process["pid"]',
  "        if pid in reused:",
  "            continue",
  "        executable = _executable_name(process)",
  "        if not executable:",
  "            skipped.append(pid)",
  "            continue",
  '        cwd = _normalize_path(process.get("cwd"))',
  '        cgroup = str(process.get("cgroup") or "")',
  "        candidates = []",
  "        for worktree in worktrees:",
  '            if cgroup and cgroup == str(worktree.get("cgroup") or ""):',
  '                candidates.append(worktree["worktreeId"])',
  '            elif cwd and cwd == _normalize_path(worktree.get("path")):',
  '                candidates.append(worktree["worktreeId"])',
  "        candidates.sort()",
  "        entry = {",
  '            "pid": pid,',
  '            "executable": executable,',
  '            "worktreeId": None,',
  '            "ownerHint": None,',
  '            "status": "unowned",',
  "        }",
  "        if len(candidates) == 1:",
  '            entry["status"] = "owned"',
  '            entry["worktreeId"] = candidates[0]',
  "            for worktree in worktrees:",
  '                if worktree["worktreeId"] == candidates[0]:',
  '                    entry["ownerHint"] = worktree.get("ownerHint")',
  "        elif len(candidates) > 1:",
  '            entry["status"] = "ambiguous"',
  '            entry["ambiguityCandidates"] = candidates',
  "        attributed.append(entry)",
  '    counts = {"owned": 0, "unowned": 0, "ambiguous": 0}',
  "    for entry in attributed:",
  '        counts[entry["status"]] += 1',
  "    return {",
  '        "attributed": attributed,',
  '        "pidReused": pid_reused,',
  '        "skippedUnknownExecutable": skipped,',
  '        "counts": counts,',
  "    }",
].join("\n");

const OWNERSHIP_SCRIPT_SOURCE = [
  "import json as _json",
  "import sys",
  "",
  "",
  OWNERSHIP_HELPER_SOURCE,
  "",
  "",
  "def main():",
  '    with open(sys.argv[1], "r", encoding="utf-8") as handle:',
  "        snapshot = _json.load(handle)",
  '    print(_json.dumps(attribute_owners(snapshot), sort_keys=True, separators=(",", ":")))',
  "",
  "",
  'if __name__ == "__main__":',
  "    main()",
].join("\n");

const OWNERSHIP_INPUT_A = {
  worktrees: [
    {
      worktreeId: "w-1",
      path: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      ownerHint: "team-platform",
    },
    { worktreeId: "w-2", path: "/srv/worktrees/beta", cgroup: "", ownerHint: "team-data" },
    {
      worktreeId: "w-3",
      path: "C:/Work/gamma",
      cgroup: "/resin/gamma.scope",
      ownerHint: "team-edge",
    },
  ],
  processes: [
    {
      pid: 101,
      ppid: 1,
      startToken: "st-101",
      cmdline: `"/usr/bin/python3.11" jobs/join.py --token ${CANARY.cmdlineTokenA}`,
      executable: "/usr/bin/python3.11",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      env: { SERVICE_TOKEN: CANARY.envTokenA },
    },
    {
      pid: 102,
      ppid: 999999,
      startToken: "st-102",
      cmdline: '"C:\\Program Files\\Python311\\python.exe" -m job',
      executable: "C:\\Program Files\\Python311\\python.exe",
      cwd: "C:/Work/gamma",
      cgroup: "",
      env: { API_KEY: CANARY.secretKeyA },
    },
    {
      pid: 103,
      ppid: 101,
      startToken: "st-103",
      cmdline: "node server.js",
      executable: "node",
      cwd: "/tmp/scratch",
      cgroup: "/resin/none.scope",
    },
    {
      pid: 104,
      ppid: 1,
      startToken: "st-104",
      cmdline: "/usr/bin/node tool.mjs",
      executable: "/usr/bin/node",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/gamma.scope",
    },
    {
      pid: 105,
      ppid: 104,
      startToken: "st-105",
      cmdline: "",
      executable: "",
      cwd: "/srv/worktrees/beta",
      cgroup: "",
    },
    {
      pid: 106,
      ppid: 105,
      startToken: "st-106",
      executable: "/usr/bin/python3.11",
      cwd: "/srv/worktrees/beta/",
      cgroup: "",
    },
    {
      pid: 107,
      ppid: 1,
      startToken: "t-1",
      cmdline: "/usr/bin/node a.js",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
    },
    {
      pid: 107,
      ppid: 1,
      startToken: "t-2",
      cmdline: "/usr/bin/node b.js",
      cwd: "/tmp/scratch",
      cgroup: "",
    },
  ],
};

const OWNERSHIP_INPUT_B = {
  worktrees: [
    {
      worktreeId: "w-1",
      path: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      ownerHint: "team-platform",
    },
    {
      worktreeId: "w-2",
      path: "/srv/worktrees/beta",
      cgroup: "/resin/alpha.scope",
      ownerHint: "team-data",
    },
  ],
  processes: [
    {
      pid: 201,
      ppid: 1,
      startToken: "st-201",
      cmdline: "/usr/lib/node_modules/.bin/tsc -p .",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
    },
    {
      pid: 202,
      ppid: 201,
      startToken: "st-202",
      cmdline: "C:\\Tools\\node.exe serve",
      cwd: "C:\\Work\\delta",
      cgroup: "",
    },
    {
      pid: 203,
      ppid: 1,
      startToken: "st-203",
      cmdline: "/usr/bin/bash run.sh",
      cwd: "/srv/worktrees/beta",
      cgroup: "",
    },
    {
      pid: 204,
      ppid: 1,
      startToken: "t-1",
      cmdline: "/usr/bin/python3.11 a.py",
      cwd: "/srv/worktrees/beta",
      cgroup: "",
    },
    {
      pid: 204,
      ppid: 1,
      startToken: "t-2",
      cmdline: "/usr/bin/python3.11 b.py",
      cwd: "/tmp/elsewhere",
      cgroup: "",
    },
    {
      pid: 205,
      ppid: 203,
      startToken: "st-205",
      cmdline: "/usr/bin/node serve.js",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      env: { DEPLOY_TOKEN: CANARY.envTokenB },
    },
    {
      pid: 207,
      ppid: 1,
      startToken: "st-207",
      parentExited: true,
      cmdline: "/usr/bin/node orphan.js",
      cwd: "/srv/worktrees/beta",
      cgroup: "",
    },
  ],
};

const OWNERSHIP_INPUT_C = {
  worktrees: [
    {
      worktreeId: "w-1",
      path: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      ownerHint: "team-platform",
    },
  ],
  processes: [
    {
      pid: 301,
      ppid: 1,
      startToken: "st-301",
      cmdline: "/usr/bin/python3 -c pass",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      env: { BUILD_SECRET: CANARY.envTokenC },
    },
    {
      pid: 302,
      ppid: 301,
      startToken: "st-302",
      cmdline: "   ",
      executable: "",
      cwd: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
    },
    {
      pid: 303,
      ppid: 1,
      startToken: "st-303",
      cmdline: "C:\\Windows\\System32\\cmd.exe /c dir",
      cwd: "C:\\Work\\gamma",
      cgroup: "",
    },
    {
      pid: 304,
      ppid: 1,
      startToken: "s-1",
      cmdline: "/usr/bin/node x.js",
      cwd: "/srv/worktrees/alpha",
      cgroup: "",
    },
    {
      pid: 304,
      ppid: 1,
      startToken: "s-2",
      cmdline: "/usr/bin/node y.js",
      cwd: "/tmp/scratch",
      cgroup: "",
    },
    {
      pid: 305,
      ppid: 1,
      startToken: "st-305",
      cmdline: "/usr/bin/node audit.js",
      cwd: "/srv/worktrees/ALPHA",
      cgroup: "",
    },
  ],
};

const OWNERSHIP_INPUT_D = {
  worktrees: [
    {
      worktreeId: "w-1",
      path: "/srv/worktrees/alpha",
      cgroup: "/resin/alpha.scope",
      ownerHint: "team-platform",
    },
    { worktreeId: "w-2", path: "C:/Work/gamma", cgroup: "", ownerHint: "team-edge" },
    { worktreeId: "w-3", path: "c:/work/gamma", cgroup: "", ownerHint: "team-edge-mirror" },
  ],
  processes: [
    {
      pid: 401,
      ppid: 1,
      startToken: "st-401",
      cmdline: '"C:\\Program Files\\nodejs\\node.exe" server.js',
      cwd: "c:/work/gamma/",
      cgroup: "",
      cmdlineToken: CANARY.cmdlineTokenB,
    },
    {
      pid: 402,
      ppid: 401,
      startToken: "st-402",
      cmdline: "/opt/tools/ffmpeg -i in.mp4",
      cwd: "/opt/tmp",
      cgroup: "/resin/other.scope",
    },
    {
      pid: 403,
      ppid: 402,
      startToken: "st-403",
      parentExited: true,
      cmdline: "/usr/bin/bash build.sh",
      cwd: "/srv/worktrees/alpha/",
      cgroup: "",
    },
    {
      pid: 404,
      ppid: 1,
      startToken: "st-404",
      cmdline: "/usr/bin/node audit.js",
      cwd: "/srv/WORKTREES/Alpha",
      cgroup: "",
    },
  ],
};

const OWNERSHIP_EXPECTED_A = {
  attributed: [
    {
      pid: 101,
      executable: "python3.11",
      worktreeId: "w-1",
      ownerHint: "team-platform",
      status: "owned",
    },
    {
      pid: 102,
      executable: "python.exe",
      worktreeId: "w-3",
      ownerHint: "team-edge",
      status: "owned",
    },
    { pid: 103, executable: "node", worktreeId: null, ownerHint: null, status: "unowned" },
    {
      pid: 104,
      executable: "node",
      worktreeId: null,
      ownerHint: null,
      status: "ambiguous",
      ambiguityCandidates: ["w-1", "w-3"],
    },
    {
      pid: 106,
      executable: "python3.11",
      worktreeId: "w-2",
      ownerHint: "team-data",
      status: "owned",
    },
  ],
  pidReused: [107],
  skippedUnknownExecutable: [105],
  counts: { owned: 3, unowned: 1, ambiguous: 1 },
};

const OWNERSHIP_EXPECTED_B = {
  attributed: [
    {
      pid: 201,
      executable: "tsc",
      worktreeId: null,
      ownerHint: null,
      status: "ambiguous",
      ambiguityCandidates: ["w-1", "w-2"],
    },
    { pid: 202, executable: "node.exe", worktreeId: null, ownerHint: null, status: "unowned" },
    { pid: 203, executable: "bash", worktreeId: "w-2", ownerHint: "team-data", status: "owned" },
    {
      pid: 205,
      executable: "node",
      worktreeId: null,
      ownerHint: null,
      status: "ambiguous",
      ambiguityCandidates: ["w-1", "w-2"],
    },
    { pid: 207, executable: "node", worktreeId: "w-2", ownerHint: "team-data", status: "owned" },
  ],
  pidReused: [204],
  skippedUnknownExecutable: [],
  counts: { owned: 2, unowned: 1, ambiguous: 2 },
};

const OWNERSHIP_EXPECTED_C = {
  attributed: [
    {
      pid: 301,
      executable: "python3",
      worktreeId: "w-1",
      ownerHint: "team-platform",
      status: "owned",
    },
    { pid: 303, executable: "cmd.exe", worktreeId: null, ownerHint: null, status: "unowned" },
    { pid: 305, executable: "node", worktreeId: null, ownerHint: null, status: "unowned" },
  ],
  pidReused: [304],
  skippedUnknownExecutable: [302],
  counts: { owned: 1, unowned: 2, ambiguous: 0 },
};

const OWNERSHIP_EXPECTED_D = {
  attributed: [
    {
      pid: 401,
      executable: "node.exe",
      worktreeId: null,
      ownerHint: null,
      status: "ambiguous",
      ambiguityCandidates: ["w-2", "w-3"],
    },
    { pid: 402, executable: "ffmpeg", worktreeId: null, ownerHint: null, status: "unowned" },
    {
      pid: 403,
      executable: "bash",
      worktreeId: "w-1",
      ownerHint: "team-platform",
      status: "owned",
    },
    { pid: 404, executable: "node", worktreeId: null, ownerHint: null, status: "unowned" },
  ],
  pidReused: [],
  skippedUnknownExecutable: [],
  counts: { owned: 1, unowned: 2, ambiguous: 1 },
};

export function buildProcessOwnershipFamily(): ComputationFixtureFamily {
  const definitionSessionId = "omp-fixture-ownership-definition-session";
  const scriptSessionId = "omp-fixture-ownership-script-session";
  const definitionClock = createComputationFixtureClock("2026-06-01T11:00:00.000Z");
  const scriptClock = createComputationFixtureClock("2026-06-01T12:00:00.000Z");

  const useCellA = pythonUseCell(canonicalJson(OWNERSHIP_INPUT_A), "attribute_owners(_DATA)");
  const useCellB = pythonUseCell(canonicalJson(OWNERSHIP_INPUT_B), "attribute_owners(_DATA)");

  const definitionRecords: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(
      definitionSessionId,
      definitionClock.next(),
      "/workspace/fixture-ownership",
    ),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-ownership-def",
      toolName: "eval",
      toolArguments: { language: "python", code: OWNERSHIP_HELPER_SOURCE },
      intent:
        "Define process ownership attribution with normalized executables and exact identity.",
      result: "",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-ownership-use-a",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellA },
      intent: "Attribute the first snapshot.",
      result: canonicalJson(OWNERSHIP_EXPECTED_A),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-ownership-use-b",
      toolName: "eval",
      toolArguments: { language: "python", code: useCellB },
      intent: "Attribute the second snapshot.",
      result: canonicalJson(OWNERSHIP_EXPECTED_B),
    }),
  ];

  const snapshotPathC = "datasets/snapshot-c.json";
  const snapshotPathD = "datasets/snapshot-d.json";
  const fileC = `${JSON.stringify(OWNERSHIP_INPUT_C, null, 2)}\n`;
  const fileD = `${JSON.stringify(OWNERSHIP_INPUT_D, null, 2)}\n`;
  const scriptPath = "tools/attribute-owners.py";

  const scriptRecords: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(
      scriptSessionId,
      scriptClock.next(),
      "/workspace/fixture-ownership-script",
    ),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-script-write",
      toolName: "write",
      toolArguments: { path: scriptPath, content: OWNERSHIP_SCRIPT_SOURCE },
      intent: "Author the ownership attribution script.",
      result: `Wrote ${scriptPath}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-script-read",
      toolName: "read",
      toolArguments: { path: scriptPath },
      intent: "Read the authored attribution script back before running it.",
      result: OWNERSHIP_SCRIPT_SOURCE,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-snapshot-c-write",
      toolName: "write",
      toolArguments: { path: snapshotPathC, content: fileC },
      intent: "Write the third snapshot.",
      result: `Wrote ${snapshotPathC}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-snapshot-c-run",
      toolName: "bash",
      toolArguments: { command: `python3 ${scriptPath} ${snapshotPathC}` },
      intent: "Attribute the third snapshot with the authored script.",
      result: canonicalJson(OWNERSHIP_EXPECTED_C),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-snapshot-d-write",
      toolName: "write",
      toolArguments: { path: snapshotPathD, content: fileD },
      intent: "Write the fourth snapshot.",
      result: `Wrote ${snapshotPathD}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-ownership-snapshot-d-run",
      toolName: "bash",
      toolArguments: { command: `python3 ${scriptPath} ${snapshotPathD}` },
      intent: "Attribute the fourth snapshot with the authored script.",
      result: canonicalJson(OWNERSHIP_EXPECTED_D),
    }),
  ];

  const scriptRunnableFor = (
    snapshotPath: string,
    snapshotFile: string,
  ): ComputationFixtureRunnable => ({
    language: "python",
    command: `python3 ${scriptPath} ${snapshotPath}`,
    files: { [scriptPath]: OWNERSHIP_SCRIPT_SOURCE, [snapshotPath]: snapshotFile },
  });

  return {
    familyId: "process-snapshot-ownership",
    language: "python",
    summary:
      "Attribute snapshot processes to worktrees by the normalized Windows/POSIX basename of the " +
      "argv[0] selected from the recorded command line, scoped by exact cgroup or worktree-path " +
      "identity, with explicit ambiguity, reused-PID and unknown-executable status, parent-exit " +
      "independence and allow-listed output.",
    negativeCase: "ambiguous-identity",
    canaries: [
      CANARY.envTokenA,
      CANARY.secretKeyA,
      CANARY.cmdlineTokenA,
      CANARY.envTokenB,
      CANARY.envTokenC,
      CANARY.cmdlineTokenB,
    ],
    variants: [
      {
        variantId: "process-ownership-definition-use",
        familyId: "process-snapshot-ownership",
        kind: "definition-use",
        sessionId: definitionSessionId,
        language: "python",
        summary: "One definition cell, then one use cell per snapshot for the same helper.",
        records: definitionRecords,
        datasets: [
          {
            datasetId: "ownership-snapshot-a",
            kind: "primary",
            summary:
              "Quoted and bare argv[0] command lines across Windows/POSIX paths, one empty command " +
              "line, one reused PID and one cgroup/path ambiguity.",
            input: OWNERSHIP_INPUT_A,
            canaries: [CANARY.envTokenA, CANARY.secretKeyA, CANARY.cmdlineTokenA],
            invocationCallId: "call-ownership-use-a",
            expected: expectedOutput(
              OWNERSHIP_EXPECTED_A,
              combinedRunnable("python", OWNERSHIP_HELPER_SOURCE, useCellA),
            ),
          },
          {
            datasetId: "ownership-snapshot-b",
            kind: "negative",
            summary:
              "Two worktrees sharing one cgroup plus a reused PID and a reparented orphan, forcing " +
              "explicit ambiguity independent of parent exit.",
            input: OWNERSHIP_INPUT_B,
            canaries: [CANARY.envTokenB],
            invocationCallId: "call-ownership-use-b",
            expected: expectedOutput(
              OWNERSHIP_EXPECTED_B,
              combinedRunnable("python", OWNERSHIP_HELPER_SOURCE, useCellB),
            ),
          },
        ],
      },
      {
        variantId: "process-ownership-file-write-then-execute",
        familyId: "process-snapshot-ownership",
        kind: "file-write-then-execute",
        sessionId: scriptSessionId,
        language: "python",
        summary:
          "The same attribution algorithm is authored as a script file and executed with bash.",
        records: scriptRecords,
        datasets: [
          {
            datasetId: "ownership-snapshot-c",
            kind: "negative",
            summary:
              "Reused PID with divergent start tokens, a whitespace-only command line, a Windows path " +
              "matching no worktree, and a POSIX cwd differing only in case that must stay unowned.",
            input: OWNERSHIP_INPUT_C,
            canaries: [CANARY.envTokenC],
            invocationCallId: "call-ownership-snapshot-c-run",
            expected: expectedOutput(OWNERSHIP_EXPECTED_C, scriptRunnableFor(snapshotPathC, fileC)),
          },
          {
            datasetId: "ownership-snapshot-d",
            kind: "primary",
            summary:
              "A quoted Windows argv[0], two genuinely equivalent Windows worktree paths producing " +
              "ambiguity, a reparented process owned by its exact cwd, and a POSIX case variant that " +
              "must not match.",
            input: OWNERSHIP_INPUT_D,
            canaries: [CANARY.cmdlineTokenB],
            invocationCallId: "call-ownership-snapshot-d-run",
            expected: expectedOutput(OWNERSHIP_EXPECTED_D, scriptRunnableFor(snapshotPathD, fileD)),
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Family 4 - javascript two-snapshot CPU tick / PSS delta
// ============================================================================

/**
 * Delta helper reusing {@link SHARED_RECORD_IO_HELPER_SOURCE}. Processes are paired by
 * pid plus start token, so a reused pid is reported as an identity change instead of a
 * bogus delta; missing tick or PSS fields stay unknown rather than becoming zero; totals
 * are summed from PSS only and RSS is reported per process without being added to totals.
 */
const CPU_PSS_HELPER_SOURCE = [
  "function normalizeExecutable(value) {",
  '  if (typeof value !== "string" || value.length === 0) {',
  '    return "";',
  "  }",
  '  const parts = value.replace(/\\\\/g, "/").split("/");',
  "  return parts[parts.length - 1].toLowerCase();",
  "}",
  "",
  "function computeSnapshotDelta(pair) {",
  "  const first = pair.snapshots[0];",
  "  const second = pair.snapshots[1];",
  "  const tickRateHz = pair.tickRateHz;",
  "  const elapsedSeconds = (Date.parse(second.capturedAt) - Date.parse(first.capturedAt)) / 1000;",
  "  const round6 = (value) => Number(value.toFixed(6));",
  "  const beforeByKey = new Map();",
  "  const firstPids = new Set();",
  "  for (const process of first.processes) {",
  '    beforeByKey.set(process.pid + ":" + process.startToken, process);',
  "    firstPids.add(process.pid);",
  "  }",
  "  const secondPids = new Set(second.processes.map((process) => process.pid));",
  "  const matchedKeys = new Set();",
  "  const deltas = [];",
  "  const identityChanged = [];",
  "  const appeared = [];",
  "  const disappeared = [];",
  "  let pssTotalDeltaBytes = 0;",
  "  let unknownPssCount = 0;",
  "  let unknownCpuCount = 0;",
  "  for (const process of second.processes) {",
  '    const key = process.pid + ":" + process.startToken;',
  "    const before = beforeByKey.get(key);",
  "    if (before === undefined) {",
  "      if (firstPids.has(process.pid)) {",
  "        const prior = first.processes.find((candidate) => candidate.pid === process.pid);",
  "        identityChanged.push({",
  "          pid: process.pid,",
  "          beforeStartToken: prior.startToken,",
  "          afterStartToken: process.startToken,",
  "        });",
  "      } else {",
  "        appeared.push({ pid: process.pid, startToken: process.startToken });",
  "      }",
  "      continue;",
  "    }",
  "    matchedKeys.add(key);",
  "    const cpuKnown = Number.isFinite(before.cpuTicks) && Number.isFinite(process.cpuTicks);",
  "    const cpuTicksDelta = cpuKnown ? process.cpuTicks - before.cpuTicks : null;",
  "    const cpuSeconds = cpuTicksDelta === null ? null : round6(cpuTicksDelta / tickRateHz);",
  "    const cpuPercent =",
  "      cpuSeconds === null || elapsedSeconds <= 0 ? null : round6((cpuSeconds / elapsedSeconds) * 100);",
  "    const pssKnown = Number.isFinite(before.pssBytes) && Number.isFinite(process.pssBytes);",
  "    const pssDeltaBytes = pssKnown ? process.pssBytes - before.pssBytes : null;",
  "    const rssKnown = Number.isFinite(before.rssBytes) && Number.isFinite(process.rssBytes);",
  "    if (pssDeltaBytes === null) {",
  "      unknownPssCount += 1;",
  "    } else {",
  "      pssTotalDeltaBytes += pssDeltaBytes;",
  "    }",
  "    if (cpuTicksDelta === null) {",
  "      unknownCpuCount += 1;",
  "    }",
  "    deltas.push({",
  "      pid: process.pid,",
  "      executable: normalizeExecutable(process.executable),",
  "      cpuTicksDelta: cpuTicksDelta,",
  "      cpuSeconds: cpuSeconds,",
  "      cpuPercent: cpuPercent,",
  "      pssDeltaBytes: pssDeltaBytes,",
  "      rssDeltaBytes: rssKnown ? process.rssBytes - before.rssBytes : null,",
  "    });",
  "  }",
  "  for (const process of first.processes) {",
  '    const key = process.pid + ":" + process.startToken;',
  "    if (matchedKeys.has(key) || secondPids.has(process.pid)) {",
  "      continue;",
  "    }",
  "    disappeared.push({ pid: process.pid, startToken: process.startToken });",
  "  }",
  "  return {",
  "    elapsedSeconds: elapsedSeconds,",
  "    tickRateHz: tickRateHz,",
  "    deltas: deltas,",
  "    identityChanged: identityChanged,",
  "    appeared: appeared,",
  "    disappeared: disappeared,",
  "    pssTotalDeltaBytes: pssTotalDeltaBytes,",
  "    unknownPssCount: unknownPssCount,",
  "    unknownCpuCount: unknownCpuCount,",
  "    rssExcludedFromTotals: true,",
  "  };",
  "}",
].join("\n");

const CPU_PSS_DEFINITION_SOURCE = `${SHARED_RECORD_IO_HELPER_SOURCE}\n\n${CPU_PSS_HELPER_SOURCE}`;

const CPU_PSS_SCRIPT_SOURCE = [
  'import { readFileSync } from "node:fs";',
  'import { parseJsonText, stableStringify } from "./record-io.mjs";',
  "",
  CPU_PSS_HELPER_SOURCE,
  "",
  "const pairPath = process.argv[2];",
  'const pair = parseJsonText(readFileSync(pairPath, "utf8"), pairPath);',
  "console.log(stableStringify(computeSnapshotDelta(pair)));",
].join("\n");

const CPU_PSS_INPUT_A = {
  tickRateHz: 100,
  snapshots: [
    {
      capturedAt: "2026-05-01T00:00:00.000Z",
      processes: [
        {
          pid: 900,
          startToken: "a1",
          executable: "/usr/bin/python3",
          cpuTicks: 1000,
          pssBytes: 5000000,
          rssBytes: 9000000,
          cmdline: `python3 jobs/join.py --token ${CANARY.cpuCmdlineA}`,
        },
        {
          pid: 901,
          startToken: "b2",
          executable: "C:\\Tools\\agent.exe",
          cpuTicks: 2000,
          pssBytes: 8000000,
          rssBytes: 12000000,
        },
        {
          pid: 902,
          startToken: "c3",
          executable: "/usr/bin/node",
          cpuTicks: 500,
          rssBytes: 3000000,
        },
        {
          pid: 905,
          startToken: "e5",
          executable: "/opt/bin/ffmpeg",
          cpuTicks: 10,
          pssBytes: 1000,
          rssBytes: 2000,
        },
      ],
    },
    {
      capturedAt: "2026-05-01T00:00:10.000Z",
      processes: [
        {
          pid: 900,
          startToken: "a1",
          executable: "/usr/bin/python3",
          cpuTicks: 1300,
          pssBytes: 5400000,
          rssBytes: 9100000,
        },
        {
          pid: 901,
          startToken: "b2",
          executable: "C:\\Tools\\agent.exe",
          cpuTicks: 3000,
          pssBytes: 6000000,
          rssBytes: 11000000,
        },
        {
          pid: 902,
          startToken: "c3",
          executable: "/usr/bin/node",
          cpuTicks: 700,
          pssBytes: 7000000,
          rssBytes: 3100000,
        },
        {
          pid: 904,
          startToken: "d4",
          executable: "/usr/bin/bash",
          cpuTicks: 50,
          pssBytes: 2000000,
          rssBytes: 2000000,
        },
      ],
    },
  ],
};

const CPU_PSS_INPUT_B = {
  tickRateHz: 250,
  snapshots: [
    {
      capturedAt: "2026-05-01T01:00:00.000Z",
      processes: [
        {
          pid: 910,
          startToken: "x1",
          executable: "/usr/bin/python3",
          cpuTicks: 2500,
          pssBytes: 1000000,
          rssBytes: 2000000,
        },
        {
          pid: 911,
          startToken: "y1",
          executable: "C:\\Program Files\\nodejs\\node.exe",
          cpuTicks: 100,
          pssBytes: 3000000,
          rssBytes: 3500000,
        },
        {
          pid: 913,
          startToken: "w1",
          executable: "/usr/bin/bash",
          cpuTicks: 800,
          pssBytes: 500000,
          rssBytes: 500000,
        },
      ],
    },
    {
      capturedAt: "2026-05-01T01:00:04.000Z",
      processes: [
        {
          pid: 910,
          startToken: "x2",
          executable: "/usr/bin/python3",
          cpuTicks: 2600,
          pssBytes: 1200000,
          rssBytes: 2100000,
        },
        {
          pid: 911,
          startToken: "y1",
          executable: "C:/Program Files/nodejs/node.exe",
          cpuTicks: 350,
          pssBytes: 3250000,
          rssBytes: 3400000,
        },
        {
          pid: 913,
          startToken: "w1",
          executable: "/usr/bin/bash",
          pssBytes: 600000,
          rssBytes: 520000,
        },
        {
          pid: 912,
          startToken: "z1",
          executable: "/usr/bin/node",
          cpuTicks: 5,
          pssBytes: 100,
          rssBytes: 100,
        },
      ],
    },
  ],
};

const CPU_PSS_INPUT_C = {
  tickRateHz: 200,
  snapshots: [
    {
      capturedAt: "2026-05-01T02:00:00.000Z",
      processes: [
        {
          pid: 920,
          startToken: "p1",
          executable: "C:\\Windows\\System32\\cmd.exe",
          cpuTicks: 400,
          pssBytes: 4000000,
          rssBytes: 6000000,
        },
        {
          pid: 921,
          startToken: "q1",
          executable: "/usr/local/bin/node",
          cpuTicks: 1000,
          pssBytes: 2000000,
          rssBytes: 2500000,
        },
      ],
    },
    {
      capturedAt: "2026-05-01T02:00:05.000Z",
      processes: [
        {
          pid: 920,
          startToken: "p1",
          executable: "C:/Windows/System32/cmd.exe",
          cpuTicks: 600,
          pssBytes: 4500000,
          rssBytes: 6100000,
        },
        {
          pid: 921,
          startToken: "q1",
          executable: "/usr/local/bin/node",
          cpuTicks: 1200,
          pssBytes: 2000000,
          rssBytes: 2500000,
        },
      ],
    },
  ],
};

const CPU_PSS_INPUT_D = {
  tickRateHz: 100,
  snapshots: [
    {
      capturedAt: "2026-05-01T03:00:00.000Z",
      processes: [
        {
          pid: 930,
          startToken: "r1",
          executable: "/usr/bin/python3",
          cpuTicks: 100,
          pssBytes: 1000000,
          rssBytes: 1500000,
          cmdline: `python3 worker.py --key ${CANARY.cpuCmdlineB}`,
        },
        {
          pid: 931,
          startToken: "s1",
          executable: "/usr/bin/python3",
          cpuTicks: 200,
          pssBytes: 2000000,
          rssBytes: 2000000,
        },
      ],
    },
    {
      capturedAt: "2026-05-01T03:00:02.000Z",
      processes: [
        {
          pid: 930,
          startToken: "r2",
          executable: "/usr/bin/python3",
          cpuTicks: 150,
          pssBytes: 1100000,
          rssBytes: 1600000,
        },
        {
          pid: 931,
          startToken: "s1",
          executable: "/usr/bin/python3",
          cpuTicks: 260,
          pssBytes: 2000000,
          rssBytes: 1900000,
        },
        {
          pid: 932,
          startToken: "t1",
          executable: "/usr/bin/node",
          cpuTicks: 10,
          pssBytes: 10,
          rssBytes: 10,
        },
      ],
    },
  ],
};

const CPU_PSS_EXPECTED_A = {
  elapsedSeconds: 10,
  tickRateHz: 100,
  deltas: [
    {
      pid: 900,
      executable: "python3",
      cpuTicksDelta: 300,
      cpuSeconds: 3,
      cpuPercent: 30,
      pssDeltaBytes: 400000,
      rssDeltaBytes: 100000,
    },
    {
      pid: 901,
      executable: "agent.exe",
      cpuTicksDelta: 1000,
      cpuSeconds: 10,
      cpuPercent: 100,
      pssDeltaBytes: -2000000,
      rssDeltaBytes: -1000000,
    },
    {
      pid: 902,
      executable: "node",
      cpuTicksDelta: 200,
      cpuSeconds: 2,
      cpuPercent: 20,
      pssDeltaBytes: null,
      rssDeltaBytes: 100000,
    },
  ],
  identityChanged: [],
  appeared: [{ pid: 904, startToken: "d4" }],
  disappeared: [{ pid: 905, startToken: "e5" }],
  pssTotalDeltaBytes: -1600000,
  unknownPssCount: 1,
  unknownCpuCount: 0,
  rssExcludedFromTotals: true,
};

const CPU_PSS_EXPECTED_B = {
  elapsedSeconds: 4,
  tickRateHz: 250,
  deltas: [
    {
      pid: 911,
      executable: "node.exe",
      cpuTicksDelta: 250,
      cpuSeconds: 1,
      cpuPercent: 25,
      pssDeltaBytes: 250000,
      rssDeltaBytes: -100000,
    },
    {
      pid: 913,
      executable: "bash",
      cpuTicksDelta: null,
      cpuSeconds: null,
      cpuPercent: null,
      pssDeltaBytes: 100000,
      rssDeltaBytes: 20000,
    },
  ],
  identityChanged: [{ pid: 910, beforeStartToken: "x1", afterStartToken: "x2" }],
  appeared: [{ pid: 912, startToken: "z1" }],
  disappeared: [],
  pssTotalDeltaBytes: 350000,
  unknownPssCount: 0,
  unknownCpuCount: 1,
  rssExcludedFromTotals: true,
};

const CPU_PSS_EXPECTED_C = {
  elapsedSeconds: 5,
  tickRateHz: 200,
  deltas: [
    {
      pid: 920,
      executable: "cmd.exe",
      cpuTicksDelta: 200,
      cpuSeconds: 1,
      cpuPercent: 20,
      pssDeltaBytes: 500000,
      rssDeltaBytes: 100000,
    },
    {
      pid: 921,
      executable: "node",
      cpuTicksDelta: 200,
      cpuSeconds: 1,
      cpuPercent: 20,
      pssDeltaBytes: 0,
      rssDeltaBytes: 0,
    },
  ],
  identityChanged: [],
  appeared: [],
  disappeared: [],
  pssTotalDeltaBytes: 500000,
  unknownPssCount: 0,
  unknownCpuCount: 0,
  rssExcludedFromTotals: true,
};

const CPU_PSS_EXPECTED_D = {
  elapsedSeconds: 2,
  tickRateHz: 100,
  deltas: [
    {
      pid: 931,
      executable: "python3",
      cpuTicksDelta: 60,
      cpuSeconds: 0.6,
      cpuPercent: 30,
      pssDeltaBytes: 0,
      rssDeltaBytes: -100000,
    },
  ],
  identityChanged: [{ pid: 930, beforeStartToken: "r1", afterStartToken: "r2" }],
  appeared: [{ pid: 932, startToken: "t1" }],
  disappeared: [],
  pssTotalDeltaBytes: 0,
  unknownPssCount: 0,
  unknownCpuCount: 0,
  rssExcludedFromTotals: true,
};

export function buildCpuPssDeltaFamily(): ComputationFixtureFamily {
  const definitionSessionId = "omp-fixture-cpu-pss-definition-session";
  const scriptSessionId = "omp-fixture-cpu-pss-script-session";
  const definitionClock = createComputationFixtureClock("2026-06-01T13:00:00.000Z");
  const scriptClock = createComputationFixtureClock("2026-06-01T14:00:00.000Z");

  const useCellA = javascriptUseCell(
    canonicalJson(CPU_PSS_INPUT_A),
    "computeSnapshotDelta(DATASET)",
  );
  const useCellB = javascriptUseCell(
    canonicalJson(CPU_PSS_INPUT_B),
    "computeSnapshotDelta(DATASET)",
  );

  const definitionRecords: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(
      definitionSessionId,
      definitionClock.next(),
      "/workspace/fixture-cpu-pss",
    ),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-cpu-pss-def",
      toolName: "eval",
      toolArguments: { language: "javascript", code: CPU_PSS_DEFINITION_SOURCE },
      intent: "Define the shared record I/O helper plus the two-snapshot CPU and PSS delta.",
      result: "",
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-cpu-pss-use-a",
      toolName: "eval",
      toolArguments: { language: "javascript", code: useCellA },
      intent: "Compute the delta for the first snapshot pair.",
      result: canonicalJson(CPU_PSS_EXPECTED_A),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: definitionSessionId,
      clock: definitionClock,
      callId: "call-cpu-pss-use-b",
      toolName: "eval",
      toolArguments: { language: "javascript", code: useCellB },
      intent: "Compute the delta for the second snapshot pair.",
      result: canonicalJson(CPU_PSS_EXPECTED_B),
    }),
  ];

  const sharedHelperPath = "tools/record-io.mjs";
  const deltaScriptPath = "tools/snapshot-delta.mjs";
  const pairPathC = "datasets/pair-c.json";
  const pairPathD = "datasets/pair-d.json";
  const fileC = `${JSON.stringify(CPU_PSS_INPUT_C, null, 2)}\n`;
  const fileD = `${JSON.stringify(CPU_PSS_INPUT_D, null, 2)}\n`;

  const scriptRecords: OmpFixtureRecord[] = [
    buildOmpFixtureSessionRecord(
      scriptSessionId,
      scriptClock.next(),
      "/workspace/fixture-cpu-pss-script",
    ),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-helper-write",
      toolName: "write",
      toolArguments: {
        path: sharedHelperPath,
        content: `${SHARED_RECORD_IO_HELPER_SOURCE}\n\nexport { parseRecordArray, parseJsonText, stableStringify };\n`,
      },
      intent: "Reuse the shared record I/O helper module written for the validation script.",
      result: `Wrote ${sharedHelperPath}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-script-write",
      toolName: "write",
      toolArguments: { path: deltaScriptPath, content: CPU_PSS_SCRIPT_SOURCE },
      intent: "Author the snapshot delta script importing the shared helper.",
      result: `Wrote ${deltaScriptPath}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-script-read",
      toolName: "read",
      toolArguments: { path: deltaScriptPath },
      intent: "Read the authored delta script back before running it.",
      result: CPU_PSS_SCRIPT_SOURCE,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-pair-c-write",
      toolName: "write",
      toolArguments: { path: pairPathC, content: fileC },
      intent: "Write the third snapshot pair.",
      result: `Wrote ${pairPathC}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-pair-c-run",
      toolName: "bash",
      toolArguments: { command: `node ${deltaScriptPath} ${pairPathC}` },
      intent: "Compute the delta for the third snapshot pair.",
      result: canonicalJson(CPU_PSS_EXPECTED_C),
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-pair-d-write",
      toolName: "write",
      toolArguments: { path: pairPathD, content: fileD },
      intent: "Write the fourth snapshot pair.",
      result: `Wrote ${pairPathD}`,
    }),
    ...buildOmpFixtureToolTurn({
      sessionId: scriptSessionId,
      clock: scriptClock,
      callId: "call-cpu-pss-pair-d-run",
      toolName: "bash",
      toolArguments: { command: `node ${deltaScriptPath} ${pairPathD}` },
      intent: "Compute the delta for the fourth snapshot pair.",
      result: canonicalJson(CPU_PSS_EXPECTED_D),
    }),
  ];

  const scriptRunnableFor = (pairPath: string, pairFile: string): ComputationFixtureRunnable => ({
    language: "javascript",
    command: `node ${deltaScriptPath} ${pairPath}`,
    files: {
      [sharedHelperPath]: `${SHARED_RECORD_IO_HELPER_SOURCE}\n\nexport { parseRecordArray, parseJsonText, stableStringify };\n`,
      [deltaScriptPath]: CPU_PSS_SCRIPT_SOURCE,
      [pairPath]: pairFile,
    },
  });

  return {
    familyId: "cpu-pss-delta",
    language: "javascript",
    summary:
      "Two-snapshot CPU tick and PSS delta with start identity matching, elapsed time and tick-rate " +
      "arithmetic, explicit unknown missing fields, and PSS-only totals that never add RSS.",
    negativeCase: "reused-pid",
    canaries: [CANARY.cpuCmdlineA, CANARY.cpuCmdlineB],
    variants: [
      {
        variantId: "cpu-pss-definition-use",
        familyId: "cpu-pss-delta",
        kind: "definition-use",
        sessionId: definitionSessionId,
        language: "javascript",
        summary:
          "Definition cell composes the shared record I/O helper with the delta algorithm, then one " +
          "use cell per snapshot pair.",
        records: definitionRecords,
        sharedHelperSource: SHARED_RECORD_IO_HELPER_SOURCE,
        datasets: [
          {
            datasetId: "cpu-pss-a",
            kind: "primary",
            summary:
              "Three matched processes, one unknown PSS, one appeared and one disappeared process.",
            input: CPU_PSS_INPUT_A,
            canaries: [CANARY.cpuCmdlineA],
            invocationCallId: "call-cpu-pss-use-a",
            expected: expectedOutput(
              CPU_PSS_EXPECTED_A,
              combinedRunnable("javascript", CPU_PSS_DEFINITION_SOURCE, useCellA),
            ),
          },
          {
            datasetId: "cpu-pss-b",
            kind: "negative",
            summary:
              "Reused PID with a changed start token and a missing tick counter on a matched process.",
            input: CPU_PSS_INPUT_B,
            canaries: [],
            invocationCallId: "call-cpu-pss-use-b",
            expected: expectedOutput(
              CPU_PSS_EXPECTED_B,
              combinedRunnable("javascript", CPU_PSS_DEFINITION_SOURCE, useCellB),
            ),
          },
        ],
      },
      {
        variantId: "cpu-pss-file-write-then-execute",
        familyId: "cpu-pss-delta",
        kind: "file-write-then-execute",
        sessionId: scriptSessionId,
        language: "javascript",
        summary:
          "The delta script is written as a module importing the shared record I/O helper and executed " +
          "with bash once per snapshot pair.",
        records: scriptRecords,
        sharedHelperSource: SHARED_RECORD_IO_HELPER_SOURCE,
        datasets: [
          {
            datasetId: "cpu-pss-c",
            kind: "primary",
            summary: "Windows and POSIX spellings of one executable across a five second interval.",
            input: CPU_PSS_INPUT_C,
            canaries: [],
            invocationCallId: "call-cpu-pss-pair-c-run",
            expected: expectedOutput(CPU_PSS_EXPECTED_C, scriptRunnableFor(pairPathC, fileC)),
          },
          {
            datasetId: "cpu-pss-d",
            kind: "negative",
            summary:
              "Reused PID whose start token changed between snapshots, so no delta is claimed.",
            input: CPU_PSS_INPUT_D,
            canaries: [CANARY.cpuCmdlineB],
            invocationCallId: "call-cpu-pss-pair-d-run",
            expected: expectedOutput(CPU_PSS_EXPECTED_D, scriptRunnableFor(pairPathD, fileD)),
          },
        ],
      },
    ],
  };
}

// ============================================================================
// Aggregate exports
// ============================================================================

export const COMPUTATION_FIXTURE_FAMILY_IDS = [
  "record-join-lineage",
  "record-schema-order",
  "process-snapshot-ownership",
  "cpu-pss-delta",
] as const;

export type ComputationFixtureFamilyId = (typeof COMPUTATION_FIXTURE_FAMILY_IDS)[number];

export function buildComputationFixtureFamilies(): ComputationFixtureFamily[] {
  return [
    buildRecordJoinFamily(),
    buildRecordSchemaOrderFamily(),
    buildProcessOwnershipFamily(),
    buildCpuPssDeltaFamily(),
  ];
}
