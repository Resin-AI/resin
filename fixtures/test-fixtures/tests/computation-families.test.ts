import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPUTATION_FIXTURE_FAMILY_IDS,
  type ComputationFixtureExpectedOutput,
  type ComputationFixtureFamily,
  type ComputationFixtureLanguage,
  type ComputationFixtureRunnable,
  type ComputationFixtureVariant,
  type OmpFixtureRecord,
  type OmpFixtureToolCallBlock,
  SHARED_RECORD_IO_HELPER_SOURCE,
  buildComputationFixtureFamilies,
  canonicalJson,
  collectOmpFixtureToolCalls,
  collectOmpFixtureToolResults,
} from "../src/index.js";

const NATIVE_TOOL_NAMES = ["eval", "read", "write", "bash"];
const IR_FORBIDDEN_KEYS = [
  "program",
  "nodes",
  "nodeKinds",
  "symbols",
  "slots",
  "programDigest",
  "evidenceId",
  "classification",
  "resinComputationEvidenceV1",
  "analysisOnly",
  "opportunity",
];
const IR_FORBIDDEN_MARKERS = ["digest", "evidence", "manifest", "telemetry"];

function collectKeys(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(item, into);
  }
}

/**
 * True when a runnable payload carries this exact dataset, whether the dataset is embedded
 * as an escaped JSON string literal in a source file or written as a standalone JSON file.
 */
function payloadEmbedsDataset(files: Record<string, string>, datasetInput: unknown): boolean {
  const target = canonicalJson(datasetInput);
  const matches = (value: unknown): boolean => {
    if (typeof value === "string") {
      try {
        return canonicalJson(JSON.parse(value)) === target;
      } catch {
        return false;
      }
    }
    return value !== null && typeof value === "object" && canonicalJson(value) === target;
  };
  for (const content of Object.values(files)) {
    try {
      if (matches(JSON.parse(content))) return true;
    } catch {
      // not a standalone JSON payload; scan embedded string literals instead
    }
    for (const literal of content.match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
      if (literal.length < 24) continue;
      try {
        if (matches(JSON.parse(literal))) return true;
      } catch {
        // not a JSON string literal
      }
    }
  }
  return false;
}

function stringifyInputs(family: ComputationFixtureFamily): string {
  return family.variants
    .flatMap((variant) => variant.datasets.map((dataset) => JSON.stringify(dataset.input)))
    .join("\n");
}

function expectedTexts(family: ComputationFixtureFamily): string[] {
  return family.variants.flatMap((variant) =>
    variant.datasets.flatMap((dataset) => [
      dataset.expected.stdout,
      JSON.stringify(dataset.expected.parsed),
      ...(dataset.superseded ? [dataset.superseded.stdout] : []),
    ]),
  );
}

function isToolExecutionEnd(
  record: OmpFixtureRecord,
): record is Extract<OmpFixtureRecord, { customType: "tool_execution_end" }> {
  return record.type === "custom" && record.customType === "tool_execution_end";
}

function variantEndRecord(variant: ComputationFixtureVariant, callId: string) {
  return variant.records
    .filter(isToolExecutionEnd)
    .find((record) => record.data.toolCallId === callId);
}

const families = buildComputationFixtureFamilies();
const familyById = new Map(families.map((family) => [family.familyId, family]));
const allVariants = families.flatMap((family) => family.variants);

// ============================================================================
// Bounded execution of the authored fixture programs
// ============================================================================

/**
 * Only the two interpreters the fixtures declare. Anything else is a fixture defect, not a
 * program to launch, so the runner refuses instead of executing an unvetted binary.
 */
const ALLOWED_INTERPRETERS: Record<ComputationFixtureLanguage, string> = {
  python: "python3",
  javascript: process.execPath,
};

const EXECUTION_TIMEOUT_MS = 10_000;
const EXECUTION_TEST_TIMEOUT_MS = 15_000;
const EXECUTION_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Split one runnable command into argv without a shell. Fixture commands are authored as a bare
 * interpreter followed by bare relative paths, so anything that only makes sense with a shell —
 * quoting, escapes, substitution, redirection, chaining, embedded whitespace — is rejected before
 * a token is ever produced. The interpreter itself is checked against an exact allowlist by the
 * caller; the remaining tokens are checked against the declared fixture paths.
 */
function splitRunnableCommand(command: string): string[] {
  expect(command).not.toMatch(/["'`\\$&|;<>(){}\n\r\t]/);
  const argv = command.split(" ");
  expect(argv.length).toBeGreaterThanOrEqual(2);
  for (const token of argv) {
    expect(token.length).toBeGreaterThan(0);
  }
  return argv;
}

/**
 * Resolve one declared relative file path under `root`, refusing anything that could escape the
 * throwaway directory: absolute paths, drive letters, UNC prefixes and `..` traversal. Every file
 * is written fresh into a fresh directory, so no pre-existing entry can redirect the write.
 */
function resolveFixturePath(root: string, relativePath: string): string {
  expect(path.isAbsolute(relativePath)).toBe(false);
  expect(/^[A-Za-z]:/.test(relativePath) || relativePath.startsWith("//")).toBe(false);
  const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  expect(segments).not.toHaveLength(0);
  expect(segments).not.toContain("..");
  const resolved = path.resolve(root, ...segments);
  expect(resolved.startsWith(`${path.resolve(root)}${path.sep}`)).toBe(true);
  return resolved;
}

/**
 * Environment free of credentials and user state: an isolated HOME plus the variables a bare
 * interpreter needs to start. `process.env` is never inherited wholesale, so ambient tokens (API
 * keys, service tokens, cloud credentials) cannot reach a fixture program. Only PATH and the
 * Windows OS locations are carried over: PATH so the declared `python3` is locatable, and
 * SystemRoot/WINDIR/PATHEXT so an interpreter starts on Windows at all. None is credential
 * material.
 */
function minimalExecutionEnv(homeDirectory: string): Record<string, string> {
  const env: Record<string, string> = {
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
    NO_COLOR: "1",
  };
  for (const key of ["SystemRoot", "WINDIR", "PATHEXT"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

interface FixtureProgramRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Materialize `runnable.files` in a fresh task-owned temp directory and run the declared
 * interpreter with no shell, a finite timeout and a bounded buffer, then clean up.
 */
function runFixtureProgram(
  language: ComputationFixtureLanguage,
  runnable: ComputationFixtureRunnable,
): FixtureProgramRun {
  const root = mkdtempSync(path.join(tmpdir(), "resin-computation-fixture-"));
  try {
    const [declared, ...args] = splitRunnableCommand(runnable.command);
    const allowed = ALLOWED_INTERPRETERS[language];
    // The authored command names the interpreter as the platform console shim (`node`), while
    // `process.execPath` may be spelled with an extension on Windows.
    const allowedTokens = [
      allowed,
      path.basename(allowed),
      path.basename(path.parse(allowed).name),
    ];
    expect(allowedTokens).toContain(declared);
    const entries = Object.entries(runnable.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const [relativePath, content] of entries) {
      const target = resolveFixturePath(root, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const declaredPaths = entries.map(([relativePath]) => relativePath);
    for (const arg of args) {
      // Every non-interpreter token is a declared relative fixture path: nothing else can
      // appear in argv, so no absolute path, flag or option reaches the program. The path
      // itself is validated (and refused on traversal) where it is written to disk.
      expect(declaredPaths).toContain(arg);
    }
    const home = path.join(root, "home");
    mkdirSync(home, { recursive: true });
    const result = spawnSync(allowed, args, {
      cwd: root,
      env: minimalExecutionEnv(home),
      encoding: "utf8",
      shell: false,
      timeout: EXECUTION_TIMEOUT_MS,
      maxBuffer: EXECUTION_MAX_BUFFER,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error ?? undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface FixtureProgramCase {
  label: string;
  familyId: string;
  language: ComputationFixtureLanguage;
  output: ComputationFixtureExpectedOutput;
  /** Canaries the dataset declares, which must be planted in the payload its program reads. */
  datasetCanaries: string[];
  /** Family-wide canaries embedded in this particular payload, for the leak assertion. */
  familyCanaries: string[];
  /** Concatenated payload files this program executes. */
  payload: string;
}

/** Every runnable program the fixture datasets declare, current and superseded. */
function collectFixtureProgramCases(): FixtureProgramCase[] {
  const cases: FixtureProgramCase[] = [];
  for (const family of families) {
    for (const variant of family.variants) {
      for (const dataset of variant.datasets) {
        const outputs: Array<[string, ComputationFixtureExpectedOutput]> = [
          ["current", dataset.expected],
        ];
        if (dataset.superseded) {
          outputs.push(["superseded", dataset.superseded]);
        }
        for (const [suffix, output] of outputs) {
          // A leak assertion is only meaningful when the token really is planted in the payload
          // the program reads, so the family-level set is derived from that payload, never
          // assumed; the dataset-level set is declared and asserted against the payload.
          const payload = Object.values(output.runnable.files).join("\n");
          cases.push({
            label: `${dataset.datasetId} (${suffix})`,
            familyId: family.familyId,
            language: family.language,
            output,
            datasetCanaries: dataset.canaries,
            familyCanaries: family.canaries.filter((canary) => payload.includes(canary)),
            payload,
          });
        }
      }
    }
  }
  return cases;
}

const programCases = collectFixtureProgramCases();

describe("synthetic computation fixture families", () => {
  it("exposes exactly the four authored families with both languages", () => {
    expect(families.map((family) => family.familyId)).toEqual([...COMPUTATION_FIXTURE_FAMILY_IDS]);
    expect([...new Set(families.map((family) => family.language))].sort()).toEqual([
      "javascript",
      "python",
    ]);
    for (const family of families) {
      expect(family.summary.length).toBeGreaterThan(0);
      expect(family.negativeCase.length).toBeGreaterThan(0);
      expect(family.canaries.length).toBeGreaterThan(0);
      expect(family.variants.length).toBeGreaterThan(0);
      for (const variant of family.variants) {
        expect(variant.familyId).toBe(family.familyId);
        expect(variant.language).toBe(family.language);
        expect(variant.sessionId.length).toBeGreaterThan(0);
        expect(variant.summary.length).toBeGreaterThan(0);
        expect(variant.records.length).toBeGreaterThan(0);
        expect(variant.datasets.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("covers every required variant kind across the four families", () => {
    const kinds = allVariants.map((variant) => variant.kind);
    expect([...new Set(kinds)].sort()).toEqual([
      "corrected-helper",
      "definition-use",
      "file-write-then-execute",
    ]);

    const corrected = (familyById.get("record-join-lineage") as ComputationFixtureFamily).variants;
    expect(corrected).toHaveLength(1);
    expect(corrected[0].kind).toBe("corrected-helper");
    const supersededSource = corrected[0].supersededDefinitionSource as string;
    expect(supersededSource).toBeTypeOf("string");
    const definitionCodes = collectOmpFixtureToolCalls(corrected[0].records)
      .filter((call) => call.toolName === "eval")
      .map((call) => (call.toolArguments as { code: string }).code);
    expect(definitionCodes.some((code) => code === supersededSource)).toBe(true);
    for (const dataset of corrected[0].datasets) {
      const superseded = dataset.superseded;
      expect(superseded?.invocationCallId).toBeTypeOf("string");
      expect(superseded?.stdout).not.toBe(dataset.expected.stdout);
      const current = dataset.expected.runnable.files["main.py"];
      const previous = superseded?.runnable.files["main.py"] as string;
      expect(previous).toContain(supersededSource);
      expect(current).not.toContain(supersededSource);
      // Same use cell both times: only the helper body changed in the correction.
      const useCellMarker = "_DATA = _json.loads(";
      expect(current.slice(current.indexOf(useCellMarker))).toBe(
        previous.slice(previous.indexOf(useCellMarker)),
      );
      expect(definitionCodes.some((code) => current.startsWith(code))).toBe(true);
      expect(definitionCodes.some((code) => previous.startsWith(code))).toBe(true);
      expect(
        variantEndRecord(corrected[0], superseded?.invocationCallId as string)?.data.result,
      ).toBe(superseded?.stdout);
    }
    // Exactly two distinct definition bodies were observed, earliest first.
    const definitionOnly = definitionCodes.filter((code) => code.includes("def join_records"));
    expect(new Set(definitionOnly).size).toBe(2);
    const supersededCall = collectOmpFixtureToolCalls(corrected[0].records).find(
      (call) => (call.toolArguments as { code: string }).code === supersededSource,
    );
    const correctedCall = collectOmpFixtureToolCalls(corrected[0].records).find(
      (call) =>
        (call.toolArguments as { code: string }).code.includes("def join_records") &&
        (call.toolArguments as { code: string }).code !== supersededSource,
    );
    expect(supersededCall?.timestamp).toBeDefined();
    expect(correctedCall?.timestamp).toBeDefined();
    expect((supersededCall?.timestamp as string) < (correctedCall?.timestamp as string)).toBe(true);

    const writeThenExecute = allVariants.filter(
      (variant) => variant.kind === "file-write-then-execute",
    );
    expect(writeThenExecute.map((variant) => variant.familyId).sort()).toEqual([
      "cpu-pss-delta",
      "process-snapshot-ownership",
      "record-schema-order",
    ]);
    for (const variant of writeThenExecute) {
      const calls = collectOmpFixtureToolCalls(variant.records);
      expect(calls.some((call) => call.toolName === "write")).toBe(true);
      expect(calls.some((call) => call.toolName === "read")).toBe(true);
      const bashCommands = calls
        .filter((call) => call.toolName === "bash")
        .map((call) => (call.toolArguments as { command: string }).command);
      expect(bashCommands.length).toBeGreaterThanOrEqual(2);
      const runnableCommands = variant.datasets.map((dataset) => dataset.expected.runnable.command);
      for (const command of bashCommands) {
        expect(runnableCommands).toContain(command);
      }
    }
  });

  it("reuses one byte-identical helper across two independent procedures", () => {
    const owners = families.filter((family) =>
      family.variants.some(
        (variant) => variant.sharedHelperSource === SHARED_RECORD_IO_HELPER_SOURCE,
      ),
    );
    expect(owners.map((family) => family.familyId).sort()).toEqual([
      "cpu-pss-delta",
      "record-schema-order",
    ]);
    expect(SHARED_RECORD_IO_HELPER_SOURCE).toContain("function parseRecordArray");
    expect(SHARED_RECORD_IO_HELPER_SOURCE).toContain("function stableStringify");
    for (const family of owners) {
      for (const variant of family.variants) {
        const payloads = variant.datasets.flatMap((dataset) =>
          Object.values(dataset.expected.runnable.files),
        );
        expect(payloads.some((payload) => payload.includes(SHARED_RECORD_IO_HELPER_SOURCE))).toBe(
          true,
        );
      }
    }
    expect(
      (familyById.get("cpu-pss-delta") as ComputationFixtureFamily).variants[0].sharedHelperSource,
    ).toBe(
      (familyById.get("record-schema-order") as ComputationFixtureFamily).variants[0]
        .sharedHelperSource,
    );
  });

  it("records every tool call with native names and identity-only execution starts", () => {
    for (const variant of allVariants) {
      expect(variant.records[0].type).toBe("session");
      const calls = collectOmpFixtureToolCalls(variant.records);
      const results = collectOmpFixtureToolResults(variant.records);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.length).toBe(new Set(calls.map((call) => call.callId)).size);
      for (const call of calls) {
        expect(NATIVE_TOOL_NAMES).toContain(call.toolName);
        const start = variant.records.find(
          (record) =>
            record.type === "custom" &&
            record.customType === "tool_execution_start" &&
            record.data.toolCallId === call.callId,
        );
        expect(start).toBeDefined();
        expect(
          start?.type === "custom" && start.customType === "tool_execution_start"
            ? Object.keys(start.data).sort()
            : [],
        ).toEqual(["toolCallId", "toolName"]);
        const result = results.find((entry) => entry.callId === call.callId);
        expect(result?.toolName).toBe(call.toolName);
        expect(result?.isError).toBe(false);
      }
      expect([...results.map((entry) => entry.callId)].sort()).toEqual(
        [...calls.map((call) => call.callId)].sort(),
      );
      const timestamps = variant.records.map((record) => record.timestamp);
      expect([...timestamps].sort()).toEqual(timestamps);
      for (const record of variant.records) {
        expect(record.sessionId).toBe(variant.sessionId);
        expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      }
    }
  });

  it("carries eval arguments in assistant toolCall content, never in execution starts", () => {
    for (const variant of allVariants) {
      const inlineEvalArguments = variant.records
        .flatMap((record) => (record.type === "message" ? record.content : []))
        .filter(
          (block): block is OmpFixtureToolCallBlock =>
            block.type === "toolCall" && block.name === "eval",
        )
        .map((block) => block.arguments as { language: string; code: string });
      const evalCalls = collectOmpFixtureToolCalls(variant.records).filter(
        (call) => call.toolName === "eval",
      );
      expect(inlineEvalArguments.length).toBe(evalCalls.length);
      if (variant.kind === "file-write-then-execute") {
        // Authored scripts execute through bash; no inline eval cell is needed.
        expect(evalCalls).toHaveLength(0);
      } else {
        expect(evalCalls.length).toBeGreaterThan(0);
      }
      for (const args of inlineEvalArguments) {
        expect(args.language).toBe(variant.language);
        expect(args.code.length).toBeGreaterThan(20);
      }
      for (const record of variant.records) {
        if (record.type !== "custom" || record.customType !== "tool_execution_start") continue;
        expect(record.data).not.toHaveProperty("code");
        expect(record.data).not.toHaveProperty("command");
        expect(record.data).not.toHaveProperty("args");
      }
    }
  });

  it("keeps datasets distinct, held out from each other, and self-consistent", () => {
    for (const variant of allVariants) {
      expect(variant.datasets.map((dataset) => dataset.kind).sort()).toEqual([
        "negative",
        "primary",
      ]);
      const inputs = variant.datasets.map((dataset) => canonicalJson(dataset.input));
      expect(inputs.length).toBe(new Set(inputs).size);
      const outputs = variant.datasets.map((dataset) => dataset.expected.stdout);
      expect(outputs.length).toBe(new Set(outputs).size);
      for (const dataset of variant.datasets) {
        expect(dataset.datasetId.length).toBeGreaterThan(0);
        expect(dataset.summary.length).toBeGreaterThan(0);
        expect(dataset.invocationCallId.length).toBeGreaterThan(0);
        expect(dataset.expected.stdout).toBe(canonicalJson(dataset.expected.parsed));
        expect(JSON.parse(dataset.expected.stdout)).toEqual(dataset.expected.parsed);
        const files = dataset.expected.runnable.files;
        expect(Object.keys(files).length).toBeGreaterThan(0);
        expect(payloadEmbedsDataset(files, dataset.input)).toBe(true);
        for (const source of Object.values(files)) {
          expect(source.length).toBeGreaterThan(20);
        }
        // The invocation record carries the same observed result as the fixture expectation.
        expect(variantEndRecord(variant, dataset.invocationCallId)?.data.result).toBe(
          dataset.expected.stdout,
        );
      }
    }
  });

  it("holds each dataset out of its siblings' runnable payloads", () => {
    for (const variant of allVariants) {
      for (const dataset of variant.datasets) {
        const files = dataset.expected.runnable.files;
        for (const sibling of variant.datasets) {
          if (sibling.datasetId === dataset.datasetId) continue;
          expect(payloadEmbedsDataset(files, sibling.input)).toBe(false);
        }
      }
    }
  });

  it("excludes planted canaries from every expected output", () => {
    const allCanaries = families.flatMap((family) => family.canaries);
    expect(new Set(allCanaries).size).toBe(allCanaries.length);
    for (const family of families) {
      for (const canary of family.canaries) {
        expect(stringifyInputs(family)).toContain(canary);
      }
    }
    for (const family of families) {
      for (const text of expectedTexts(family)) {
        for (const canary of allCanaries) {
          expect(text).not.toContain(canary);
        }
      }
    }
    for (const variant of allVariants) {
      for (const dataset of variant.datasets) {
        for (const canary of [...dataset.canaries, ...families.flatMap((f) => f.canaries)]) {
          expect(dataset.expected.stdout).not.toContain(canary);
          expect(JSON.stringify(dataset.expected.parsed)).not.toContain(canary);
        }
      }
    }
    // Canaries are planted in the dataset inputs, so their absence from outputs is meaningful.
    expect(allCanaries.every((canary) => canary.startsWith("CANARY_"))).toBe(true);
    for (const variant of allVariants) {
      const recordedResults = variant.records
        .filter(isToolExecutionEnd)
        .map((record) => record.data.result)
        .join("\n");
      for (const dataset of variant.datasets) {
        if (dataset.canaries.length > 0) {
          const datasetText = JSON.stringify(dataset.input);
          for (const canary of dataset.canaries) {
            expect(datasetText).toContain(canary);
          }
        }
        for (const canary of allCanaries) {
          expect(recordedResults).not.toContain(canary);
        }
      }
    }
  });

  it("attaches no computation IR, digests or classification to any fixture", () => {
    const keys = new Set<string>();
    collectKeys(families, keys);
    for (const forbidden of IR_FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
    const serialized = JSON.stringify(families);
    for (const marker of IR_FORBIDDEN_MARKERS) {
      expect(serialized).not.toContain(marker);
    }
    for (const variant of allVariants) {
      for (const key of Object.keys(variant)) {
        expect([
          "datasets",
          "familyId",
          "kind",
          "language",
          "records",
          "sessionId",
          "sharedHelperSource",
          "summary",
          "supersededDefinitionSource",
          "variantId",
        ]).toContain(key);
      }
    }
  });

  it("keeps ownership output allow-listed and delta totals PSS-only with unknowns unzeroed", () => {
    const ownershipFamily = familyById.get(
      "process-snapshot-ownership",
    ) as ComputationFixtureFamily;
    for (const dataset of ownershipFamily.variants.flatMap((variant) => variant.datasets)) {
      const parsed = dataset.expected.parsed as {
        attributed: Array<Record<string, unknown>>;
        counts: Record<string, number>;
      };
      expect(parsed.attributed.length).toBeGreaterThan(0);
      for (const entry of parsed.attributed) {
        for (const key of Object.keys(entry)) {
          expect([
            "pid",
            "executable",
            "worktreeId",
            "ownerHint",
            "status",
            "ambiguityCandidates",
          ]).toContain(key);
        }
        expect(["owned", "unowned", "ambiguous"]).toContain(entry.status);
        expect(typeof entry.executable).toBe("string");
        expect(entry.executable as string).not.toContain("/");
        expect(entry.executable as string).not.toContain("\\");
      }
      // Counts are a total function over the attributed rows, never a partial tally.
      const tally = parsed.attributed.reduce<Record<string, number>>((acc, entry) => {
        const status = entry.status as string;
        acc[status] = (acc[status] ?? 0) + 1;
        return acc;
      }, {});
      expect(parsed.counts).toEqual({
        owned: tally.owned ?? 0,
        unowned: tally.unowned ?? 0,
        ambiguous: tally.ambiguous ?? 0,
      });
    }

    const deltaFamily = familyById.get("cpu-pss-delta") as ComputationFixtureFamily;
    for (const dataset of deltaFamily.variants.flatMap((variant) => variant.datasets)) {
      const parsed = dataset.expected.parsed as {
        elapsedSeconds: number;
        tickRateHz: number;
        deltas: Array<{
          cpuTicksDelta: number | null;
          cpuSeconds: number | null;
          pssDeltaBytes: number | null;
          rssDeltaBytes: number | null;
        }>;
        pssTotalDeltaBytes: number;
        unknownPssCount: number;
        unknownCpuCount: number;
        rssExcludedFromTotals: boolean;
      };
      const knownPss = parsed.deltas
        .map((delta) => delta.pssDeltaBytes)
        .filter((value): value is number => value !== null);
      const knownRss = parsed.deltas
        .map((delta) => delta.rssDeltaBytes)
        .filter((value): value is number => value !== null);
      // Totals sum PSS only: RSS never enters, even though RSS deltas are reported.
      expect(parsed.pssTotalDeltaBytes).toBe(knownPss.reduce((sum, value) => sum + value, 0));
      expect(parsed.rssExcludedFromTotals).toBe(true);
      expect(parsed.unknownPssCount).toBe(parsed.deltas.length - knownPss.length);
      expect(parsed.unknownCpuCount).toBe(
        parsed.deltas.filter((delta) => delta.cpuTicksDelta === null).length,
      );
      for (const delta of parsed.deltas) {
        // A missing field is reported unknown, never silently zeroed.
        if (delta.cpuTicksDelta === null) {
          expect(delta.cpuSeconds).toBeNull();
        } else {
          expect(delta.cpuSeconds).toBeCloseTo(delta.cpuTicksDelta / parsed.tickRateHz, 6);
        }
      }
      const unknownCpuDeltas = parsed.deltas.filter((delta) => delta.cpuTicksDelta === null);
      const unknownPssDeltas = parsed.deltas.filter((delta) => delta.pssDeltaBytes === null);
      expect(unknownCpuDeltas.every((delta) => delta.cpuTicksDelta !== 0)).toBe(true);
      expect(unknownPssDeltas.every((delta) => delta.pssDeltaBytes !== 0)).toBe(true);
      if (knownRss.length > 0) {
        // PSS-only totals are already asserted; the not-equal is only informative when the
        // RSS deltas are non-zero, which is exactly the double-counting case.
        const rssSum = knownRss.reduce((sum, value) => sum + value, 0);
        if (rssSum !== 0) {
          expect(parsed.pssTotalDeltaBytes).not.toBe(
            knownPss.reduce((sum, value) => sum + value, 0) + rssSum,
          );
        }
      }
    }
  });

  it("derives ownership from argv[0] and stays independent of parent exit", () => {
    const ownership = familyById.get("process-snapshot-ownership") as ComputationFixtureFamily;
    const allDatasets = ownership.variants.flatMap((variant) => variant.datasets);

    // Programs read the recorded command line; no live OS reader is referenced anywhere.
    const sources = ownership.variants
      .flatMap((variant) =>
        variant.datasets.flatMap((dataset) => Object.values(dataset.expected.runnable.files)),
      )
      .concat(
        ownership.variants.flatMap((variant) =>
          variant.records.flatMap((record) =>
            record.type === "message"
              ? record.content
                  .filter((block) => block.type === "toolCall")
                  .map((block) => JSON.stringify(block.arguments))
              : [],
          ),
        ),
      );
    expect(sources.some((source) => source.includes("_argv0"))).toBe(true);
    for (const source of sources) {
      for (const forbidden of ["/proc", "psutil", "subprocess", "os.environ", "import os"]) {
        expect(source).not.toContain(forbidden);
      }
    }

    for (const dataset of allDatasets) {
      const parsed = dataset.expected.parsed as {
        attributed: Array<{ pid: number; executable: string; status: string }>;
        pidReused: number[];
        skippedUnknownExecutable: number[];
      };
      const input = dataset.input as {
        processes: Array<{ pid: number; cmdline?: string; executable?: string; ppid?: number }>;
      };
      const byPid = new Map(input.processes.map((process) => [process.pid, process]));
      for (const entry of parsed.attributed) {
        const process = byPid.get(entry.pid);
        expect(process).toBeDefined();
        // The reported name comes from the command line's argv[0], not a pre-normalized label.
        const argv0 = (process?.cmdline ?? process?.executable ?? "").trim();
        expect(argv0.length).toBeGreaterThan(0);
        const expectedName = (
          argv0.startsWith('"') ? argv0.slice(1, argv0.indexOf('"', 1)) : argv0.split(" ")[0]
        )
          .replace(/\\/g, "/")
          .split("/")
          .pop()
          ?.toLowerCase();
        expect(entry.executable).toBe(expectedName);
        // Every reported name is a bare basename: separator-free and allow-listed.
        expect(entry.executable).not.toContain("/");
        expect(entry.executable).not.toContain("\\");
      }
      // Reused PIDs and empty command lines are reported, never attributed.
      const attributedPids = parsed.attributed.map((entry) => entry.pid);
      for (const pid of parsed.pidReused) {
        expect(attributedPids).not.toContain(pid);
      }
      for (const pid of parsed.skippedUnknownExecutable) {
        expect(attributedPids).not.toContain(pid);
      }
      // Protected data never reaches the report.
      const report = JSON.stringify(parsed);
      for (const key of [
        "env",
        "cmdlineToken",
        "API_KEY",
        "SERVICE_TOKEN",
        "BUILD_SECRET",
        "DEPLOY_TOKEN",
      ]) {
        expect(report).not.toContain(key);
      }
    }

    // POSIX worktree paths stay case-sensitive: a cwd differing only in case must not match.
    const posixCaseMismatches = allDatasets.flatMap((dataset) => {
      const input = dataset.input as {
        worktrees: Array<{ worktreeId: string; path: string; cgroup: string }>;
        processes: Array<{ pid: number; cwd?: string; cgroup?: string }>;
      };
      const parsed = dataset.expected.parsed as {
        attributed: Array<{ pid: number; status: string }>;
      };
      const windowsPath = (path: string) => path.startsWith("//") || /^[A-Za-z]:/.test(path);
      return input.processes
        .filter((process) => {
          const cwd = (process.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
          if (!cwd || windowsPath(cwd)) return false;
          const exact = input.worktrees.some(
            (worktree) => worktree.path.replace(/\\/g, "/").replace(/\/+$/, "") === cwd,
          );
          const folded = input.worktrees.some(
            (worktree) =>
              worktree.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
              cwd.toLowerCase(),
          );
          const cgroupMatches = Boolean(
            process.cgroup &&
              input.worktrees.some((worktree) => worktree.cgroup === process.cgroup),
          );
          return !exact && folded && !cgroupMatches;
        })
        .map((process) => ({
          datasetId: dataset.datasetId,
          pid: process.pid,
          status: parsed.attributed.find((entry) => entry.pid === process.pid)?.status,
        }));
    });
    expect(posixCaseMismatches.length).toBeGreaterThan(0);
    for (const mismatch of posixCaseMismatches) {
      expect(mismatch.status).toBe("unowned");
    }

    // Windows drive paths genuinely equivalent modulo case/separators do produce ambiguity.
    const windowsEquivalent = allDatasets.flatMap((dataset) => {
      const input = dataset.input as {
        worktrees: Array<{ path: string }>;
        processes: Array<{ pid: number; cwd?: string; cgroup?: string }>;
      };
      const parsed = dataset.expected.parsed as {
        attributed: Array<{ pid: number; status: string; ambiguityCandidates?: string[] }>;
      };
      return input.processes
        .filter((process) => {
          const cwd = (process.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
          if (!/^[A-Za-z]:/.test(cwd)) return false;
          const exactCount = input.worktrees.filter(
            (worktree) =>
              worktree.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
              cwd.toLowerCase(),
          ).length;
          return exactCount > 1 && !process.cgroup;
        })
        .map((process) => ({
          pid: process.pid,
          entry: parsed.attributed.find((row) => row.pid === process.pid),
        }));
    });
    expect(windowsEquivalent.length).toBeGreaterThan(0);
    for (const candidate of windowsEquivalent) {
      expect(candidate.entry?.status).toBe("ambiguous");
      expect(candidate.entry?.ambiguityCandidates?.length).toBeGreaterThan(1);
    }

    // Parent exit / reparenting does not change attribution: a process whose recorded parent
    // exited but whose cwd stays exact is still owned.
    const reparented = allDatasets.filter((dataset) =>
      (dataset.input as { processes: Array<{ parentExited?: boolean }> }).processes.some(
        (process) => process.parentExited === true,
      ),
    );
    expect(reparented.length).toBeGreaterThanOrEqual(2);
    for (const dataset of reparented) {
      const parsed = dataset.expected.parsed as {
        attributed: Array<{ pid: number; status: string }>;
      };
      const reparentedPids = (
        dataset.input as { processes: Array<{ pid: number; parentExited?: boolean }> }
      ).processes
        .filter((process) => process.parentExited === true)
        .map((process) => process.pid);
      for (const pid of reparentedPids) {
        expect(parsed.attributed.find((entry) => entry.pid === pid)?.status).toBe("owned");
      }
    }
  });

  it("covers the documented negative case of each family in its datasets", () => {
    expect(familyById.get("record-join-lineage")?.negativeCase).toBe("missing-joins");
    expect(familyById.get("record-schema-order")?.negativeCase).toBe("invalid-order");
    expect(familyById.get("process-snapshot-ownership")?.negativeCase).toBe("ambiguous-identity");
    expect(familyById.get("cpu-pss-delta")?.negativeCase).toBe("reused-pid");

    const joinNegative = (familyById.get("record-join-lineage") as ComputationFixtureFamily)
      .variants[0].datasets[1];
    expect(joinNegative.kind).toBe("negative");
    const joinParsed = joinNegative.expected.parsed as {
      joined: Array<{ recordId: string; team: string | null; costCenter: string | null }>;
      missingOwners: string[];
      missingTeams: string[];
      missingParents: string[];
      excludedChildRows: string[];
      excludedRevisionRows: string[];
    };
    expect(joinParsed.missingOwners.length).toBeGreaterThan(0);
    expect(joinParsed.missingTeams.length).toBeGreaterThan(0);
    expect(joinParsed.missingParents.length).toBeGreaterThan(0);
    expect(joinParsed.excludedChildRows.length).toBeGreaterThan(0);
    expect(joinParsed.excludedRevisionRows.length).toBeGreaterThan(0);

    // The team relation is a real third hop, not a value copied from the owner row.
    const joinFamily = familyById.get("record-join-lineage") as ComputationFixtureFamily;
    for (const dataset of joinFamily.variants.flatMap((variant) => variant.datasets)) {
      const parsed = dataset.expected.parsed as {
        joined: Array<{ recordId: string; team: string | null; costCenter: string | null }>;
        missingTeams: string[];
      };
      expect(parsed.joined.length).toBeGreaterThan(0);
      const resolved = parsed.joined.filter((row) => row.team !== null);
      expect(resolved.length).toBeGreaterThan(0);
      for (const row of resolved) {
        expect(row.costCenter).not.toBeNull();
      }
      // A record whose team resolves is never listed as a missing team, and vice versa.
      expect(
        parsed.joined
          .filter((row) => row.team === null)
          .map((row) => row.recordId)
          .every((id) => parsed.missingTeams.includes(id)),
      ).toBe(true);
      for (const id of parsed.missingTeams) {
        expect(parsed.joined.some((row) => row.recordId === id && row.team !== null)).toBe(false);
      }
      expect(dataset.expected.runnable.files["main.py"]).toContain("by_team");
      // Excluded child rows are absent from the join entirely.
      const excluded = [
        ...(parsed as { excludedChildRows?: string[] }).excludedChildRows,
        ...(parsed as { excludedRevisionRows?: string[] }).excludedRevisionRows,
      ];
      for (const id of excluded) {
        expect(parsed.joined.some((row) => row.recordId === id)).toBe(false);
      }
    }

    const orderNegative = (familyById.get("record-schema-order") as ComputationFixtureFamily)
      .variants[0].datasets[1];
    expect(orderNegative.kind).toBe("negative");
    const orderParsed = orderNegative.expected.parsed as {
      issues: unknown[];
      orderViolations: unknown[];
      invalidCount: number;
    };
    expect(orderParsed.issues.length).toBeGreaterThan(0);
    expect(orderParsed.orderViolations.length).toBeGreaterThan(0);
    expect(orderParsed.invalidCount).toBeGreaterThan(0);

    const ownershipFamily = familyById.get(
      "process-snapshot-ownership",
    ) as ComputationFixtureFamily;
    const ownershipNegatives = ownershipFamily.variants
      .flatMap((variant) => variant.datasets)
      .filter((dataset) => dataset.kind === "negative");
    expect(ownershipNegatives.length).toBeGreaterThanOrEqual(2);
    const ownershipParsed = ownershipNegatives.map(
      (dataset) =>
        dataset.expected.parsed as {
          attributed: Array<{ status: string }>;
          pidReused: number[];
          skippedUnknownExecutable: number[];
        },
    );
    expect(
      ownershipParsed.some((parsed) =>
        parsed.attributed.some((entry) => entry.status === "ambiguous"),
      ),
    ).toBe(true);
    for (const parsed of ownershipParsed) {
      expect(
        parsed.attributed.some((entry) => entry.status === "ambiguous") ||
          parsed.pidReused.length > 0 ||
          parsed.skippedUnknownExecutable.length > 0,
      ).toBe(true);
    }

    const deltaFamily = familyById.get("cpu-pss-delta") as ComputationFixtureFamily;
    const deltaNegatives = deltaFamily.variants
      .flatMap((variant) => variant.datasets)
      .filter((dataset) => dataset.kind === "negative");
    expect(deltaNegatives.length).toBeGreaterThanOrEqual(2);
    for (const dataset of deltaNegatives) {
      const deltaParsed = dataset.expected.parsed as {
        identityChanged: unknown[];
        rssExcludedFromTotals: boolean;
        deltas: Array<{ pid: number }>;
        appeared: unknown[];
      };
      expect(deltaParsed.identityChanged.length).toBeGreaterThan(0);
      expect(deltaParsed.rssExcludedFromTotals).toBe(true);
      expect(deltaParsed.appeared.length).toBeGreaterThan(0);
    }
    const latestDelta = deltaNegatives[deltaNegatives.length - 1].expected.parsed as {
      identityChanged: Array<{ pid: number; beforeStartToken: string; afterStartToken: string }>;
      deltas: Array<{ pid: number }>;
    };
    expect(latestDelta.identityChanged[0].pid).toBe(930);
    expect(latestDelta.identityChanged[0].beforeStartToken).not.toBe(
      latestDelta.identityChanged[0].afterStartToken,
    );
    expect(latestDelta.deltas.some((delta) => delta.pid === 930)).toBe(false);
  });
});

describe("authored computation fixture programs reproduce their own golden outputs", () => {
  it("covers every declared runnable program, current and superseded", () => {
    expect(programCases).toHaveLength(14);
    const current = programCases.filter((program) => program.label.endsWith("(current)"));
    const superseded = programCases.filter((program) => program.label.endsWith("(superseded)"));
    expect(current).toHaveLength(12);
    expect(superseded).toHaveLength(2);
    expect(superseded.map((program) => program.label)).toEqual([
      "join-records-a (superseded)",
      "join-records-b (superseded)",
    ]);
    const countByFamily = current.reduce<Record<string, number>>((acc, program) => {
      acc[program.familyId] = (acc[program.familyId] ?? 0) + 1;
      return acc;
    }, {});
    expect(countByFamily).toEqual({
      "record-join-lineage": 2,
      "record-schema-order": 2,
      "process-snapshot-ownership": 4,
      "cpu-pss-delta": 4,
    });
    for (const program of programCases) {
      expect(Object.keys(program.output.runnable.files).length).toBeGreaterThan(0);
      // Canaries the dataset declares as planted really are present in the payload the program
      // executes, so the leak assertions below cannot silently pass over an unplanted token.
      for (const canary of program.datasetCanaries) {
        expect(program.payload, `${program.familyId} / ${program.label}`).toContain(canary);
      }
    }
    // Every canary of every family is planted in at least one payload of its own family, so the
    // leak checks below cannot be vacuous for any family.
    for (const family of families) {
      const plantedByFamily = new Set(
        programCases
          .filter((program) => program.familyId === family.familyId)
          .flatMap((program) => program.familyCanaries.concat(program.datasetCanaries)),
      );
      for (const canary of family.canaries) {
        expect(plantedByFamily, `${family.familyId} canary ${canary}`).toContain(canary);
      }
    }
  });

  it.each(programCases)(
    "runs $label and matches the independent golden output",
    ({ label, familyId, language, output, familyCanaries, datasetCanaries }) => {
      const run = runFixtureProgram(language, output.runnable);
      const diagnostic = [
        `${familyId} / ${label}`,
        `command: ${output.runnable.command}`,
        `status: ${String(run.status)}`,
        `stderr: ${run.stderr}`,
      ].join("\n");
      expect(run.error, diagnostic).toBeUndefined();
      expect(run.status, diagnostic).toBe(0);
      // print() and console.log() each append exactly one newline (CRLF if the interpreter
      // translates it); the golden stdout is the canonical payload itself, so that single
      // trailing newline is the only tolerated difference from the independent expectation.
      const stdout = run.stdout.replace(/\r?\n$/, "");
      expect(stdout, diagnostic).toBe(output.stdout);
      // The golden `parsed` value is an independent literal, not derived from this execution:
      // comparing it against the program's own stdout is what makes the assertion meaningful.
      expect(JSON.parse(stdout) as unknown, diagnostic).toEqual(output.parsed);
      for (const canary of [...familyCanaries, ...datasetCanaries]) {
        expect(run.stdout, `${diagnostic}\ncanary: ${canary}`).not.toContain(canary);
        expect(run.stderr, `${diagnostic}\ncanary: ${canary}`).not.toContain(canary);
      }
    },
    EXECUTION_TEST_TIMEOUT_MS,
  );
});
