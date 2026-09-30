/**
 * Literals inside a program a shell command embeds — a python heredoc, a `-c` string — offered as
 * inputs when the instruction named them, addressed inside that program so the command's own token
 * indexes never move.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRecordDecoder } from "@resin/adapter-codex";
import type { NormalizedSessionEvent, WorkflowBindingCandidate } from "@resin/contracts";
import {
  applyProgramTokenValues,
  bindProgramToken,
  embeddedPrograms,
  programTokenPath,
  tokenizeProgram,
} from "@resin/contracts";
import { describe, expect, it } from "vitest";
import { projectEventToMetadataOnly } from "../../src/analytics/metadata-projection.js";
import { InMemoryPrivateValueStore } from "../../src/analytics/private-value-store.js";
import {
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  WorkflowCallRecorder,
  readWorkflowCallCarrier,
} from "../../src/analytics/workflow-call-recorder.js";
import { recordCallsFromEvents } from "../../src/analytics/workflow-recipe.js";
import { NormalizationPipeline } from "../../src/normalization/pipeline.js";

const WORKSPACE = "workspace-embedded-program-candidates";

const DABSTEP_COMMAND = `python3 - <<'PY'
import csv
rows=[r for r in csv.DictReader(open('data/payments.csv')) if r['merchant']=='Belles_cookbook_store' and r['day_of_year']=='12']
print(len(rows))
PY`;

const INSTRUCTION =
  "How many transactions did Belles_cookbook_store process on the 12th day of the year?";

/** Records one Codex command after one instruction, through the real normalization pipeline. */
async function recordCodexCommand(
  sessionId: string,
  instruction: string,
  command: string,
  customSecrets: string[] = [],
) {
  const store = new InMemoryPrivateValueStore();
  const pipeline = new NormalizationPipeline({
    privateValueStore: store,
    redactionConfig: { customSecrets, sensitiveEnvVars: [] },
  });
  pipeline.registerDecoder(new CodexRecordDecoder());
  const recorder = new WorkflowCallRecorder({ privateValues: store });
  const timestamp = "2026-09-26T12:00:00.000Z";
  const native = [
    { type: "session_meta", payload: { session_id: sessionId, id: sessionId, cwd: "/work" } },
    { type: "turn_context", payload: { turn_id: "turn", cwd: "/work", model: "gpt-6-sol" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: instruction }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: {
          type: "CommandExecution",
          id: `exec-${sessionId}`,
          command: ["/bin/bash", "-lc", command],
          cwd: "file:///work",
          status: "completed",
          stdout: "2\n",
          stderr: "",
          exit_code: 0,
          duration: { secs: 0, nanos: 5_000_000 },
        },
        started_at_ms: 1_000,
        completed_at_ms: 1_005,
      },
    },
  ];
  const observed: NormalizedSessionEvent[] = [];
  for (const [index, entry] of native.entries()) {
    const ordinal = index + 1;
    for (const result of await pipeline.processRecord(
      {
        recordId: `rec_${sessionId}_${ordinal}`,
        sessionId,
        harnessId: "codex-cli",
        sequenceNumber: ordinal,
        recordType: "transcript_line",
        timestamp,
        rawPayload: JSON.stringify({ timestamp, ordinal, ...entry }),
        cursor: { offset: ordinal, line: ordinal, sequence: ordinal, timestamp },
        metadata: {},
      },
      { sessionId, harnessId: "codex-cli", workspaceId: WORKSPACE },
    )) {
      if (result.status !== "success" || result.isDuplicate) continue;
      observed.push(recorder.observe(result.event, { workspaceId: WORKSPACE }));
    }
  }
  const commandEvent = observed.find((entry) => entry.type === "command_exec");
  const carrier = readWorkflowCallCarrier(
    commandEvent?.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY],
  );
  if (carrier === undefined) throw new Error("expected a command carrier");
  return { carrier, observed };
}

/** The embedded literal each embedded candidate addresses, read from the recorded command. */
function embeddedValues(command: string, candidates: readonly WorkflowBindingCandidate[]) {
  const programs = embeddedPrograms(command);
  return candidates.flatMap((candidate) => {
    const address = programTokenPath(candidate.path);
    if (address?.embedded === undefined) return [];
    const program = programs.find((entry) => entry.anchor === address.token);
    return [program?.tokens[address.embedded]?.value];
  });
}

describe("literals inside an embedded program", () => {
  it("offers the literals the instruction named, and binding them runs python3 with new values", async () => {
    const { carrier, observed } = await recordCodexCommand(
      "codex-embedded-dabstep",
      INSTRUCTION,
      DABSTEP_COMMAND,
    );
    const candidates = carrier.candidates ?? [];
    // `12th` names `12`; `'merchant'`, `'day_of_year'` and the csv path were not named.
    expect(embeddedValues(DABSTEP_COMMAND, candidates).sort()).toEqual([
      "12",
      "Belles_cookbook_store",
    ]);
    const heredoc = embeddedPrograms(DABSTEP_COMMAND)[0]!;
    for (const candidate of candidates.filter((entry) => entry.path.length === 4)) {
      expect(candidate.path.slice(0, 3)).toEqual(["tokens", heredoc.anchor, "embedded"]);
      expect(candidate.proposed).toMatchObject({ kind: "input", recordedDefault: true });
    }

    // The published recording carries the same embedded candidates.
    const recipe = recordCallsFromEvents(
      "codex-embedded-dabstep",
      observed.map((entry) => projectEventToMetadataOnly(entry)),
    );
    const recorded = recipe?.workflow.candidates?.filter(
      (candidate) => programTokenPath(candidate.path)?.embedded !== undefined,
    );
    expect(recorded).toHaveLength(2);

    // Bind both as the runtime does and run the rendered program.
    let template = bindProgramToken(
      { type: "literal", value: DABSTEP_COMMAND },
      "shell",
      heredoc.anchor,
      { type: "input", name: "merchant" },
      programTokenPath(recorded![0]!.path)!.embedded,
    );
    template = bindProgramToken(
      template,
      "shell",
      heredoc.anchor,
      { type: "input", name: "day" },
      programTokenPath(recorded![1]!.path)!.embedded,
    );
    if (template.type !== "program") throw new Error("expected a program template");
    const byValue = new Map([
      ["Belles_cookbook_store", "Martinis_Fine_Steakhouse"],
      ["12", "10"],
    ]);
    const bound = new Map(
      template.holes.map((hole) => [
        hole.embedded!,
        byValue.get(String(heredoc.tokens[hole.embedded!]!.value))!,
      ]),
    );
    const rendered = applyProgramTokenValues(
      DABSTEP_COMMAND,
      tokenizeProgram("shell", DABSTEP_COMMAND),
      new Map(),
      "shell",
      new Map([[heredoc.anchor, bound]]),
    );
    expect(rendered).toContain("=='Martinis_Fine_Steakhouse'");
    expect(rendered).toContain("=='10'");

    const python = spawnSync("python3", ["--version"]);
    if (python.status !== 0) return;
    const work = mkdtempSync(join(tmpdir(), "resin-embedded-"));
    try {
      mkdirSync(join(work, "data"));
      writeFileSync(
        join(work, "data", "payments.csv"),
        [
          "merchant,day_of_year",
          "Belles_cookbook_store,12",
          "Belles_cookbook_store,12",
          "Martinis_Fine_Steakhouse,10",
          "Martinis_Fine_Steakhouse,10",
          "Martinis_Fine_Steakhouse,10",
          "Martinis_Fine_Steakhouse,12",
        ].join("\n"),
      );
      const run = (program: string) =>
        spawnSync("bash", ["-c", program], { cwd: work, encoding: "utf8" }).stdout;
      expect(run(DABSTEP_COMMAND)).toBe("2\n");
      expect(run(rendered)).toBe("3\n");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("offers no literal the instruction did not name", async () => {
    const { carrier } = await recordCodexCommand(
      "codex-embedded-unnamed",
      "Count the transactions for the store I care about.",
      DABSTEP_COMMAND,
    );
    expect(embeddedValues(DABSTEP_COMMAND, carrier.candidates ?? [])).toEqual([]);
  });

  it("offers the other literals of a heredoc that carries a secret, never the secret", async () => {
    const secret = "sk-live-embedded9QX";
    const command = DABSTEP_COMMAND.replace("import csv", `import csv\nKEY='${secret}'`);
    const { carrier, observed } = await recordCodexCommand(
      "codex-embedded-secret",
      INSTRUCTION,
      command,
      [secret],
    );
    expect(embeddedValues(command, carrier.candidates ?? [])).toEqual([
      "Belles_cookbook_store",
      "12",
    ]);
    expect(JSON.stringify(carrier)).not.toContain(secret);
    expect(
      JSON.stringify(observed.map((entry) => projectEventToMetadataOnly(entry))),
    ).not.toContain(secret);
  });

  it("offers a record's filter values under their column names and never the column names", async () => {
    const command = `python3 - <<'PY'
import json
p=json.load(open('data/payments.json'))
f=json.load(open('data/fees.json'))
t=[x for x in p if x['merchant']=='Belles_cookbook_store' and x['year']=='2023' and x['day_of_year']=='12']
print(len(t), len(f))
PY`;
    const { carrier } = await recordCodexCommand(
      "codex-embedded-record-fields",
      "For the 12th of the year 2023, what is the total fees (in euros) that Belles_cookbook_store should pay?",
      command,
    );
    const embedded = (carrier.candidates ?? []).filter(
      (candidate) => programTokenPath(candidate.path)?.embedded !== undefined,
    );
    const values = embeddedValues(command, embedded);
    const named = new Map(
      embedded.map((candidate, index) => [
        candidate.proposed.kind === "input" ? candidate.proposed.name : undefined,
        values[index],
      ]),
    );
    expect(named.get("merchant")).toBe("Belles_cookbook_store");
    expect(named.get("year")).toBe("2023");
    expect(named.get("day_of_year")).toBe("12");
    for (const key of ["merchant", "year", "day_of_year"]) expect(values).not.toContain(key);
  });

  it("still offers a request-named key a record subscripts alone", async () => {
    const command = `python3 - <<'PY'
d=json.load(open('data/d.json'))
print(d['alpha'])
PY`;
    const { carrier } = await recordCodexCommand(
      "codex-embedded-single-key",
      "Print the alpha entry.",
      command,
    );
    expect(embeddedValues(command, carrier.candidates ?? [])).toContain("alpha");
  });
});

const REPORT_COMMAND =
  "report build --region emea --month 2025-03 --out out/emea-2025-03/summary.csv";
const REPORT_INSTRUCTION = "Build the monthly report for region emea, month 2025-03";

/** Each input candidate as `name@path`, with a span shown as the recorded text it covers. */
function inputOffers(command: string, candidates: readonly WorkflowBindingCandidate[]) {
  const tokens = tokenizeProgram("shell", command);
  return candidates.flatMap((candidate) => {
    if (candidate.proposed.kind !== "input") return [];
    const address = programTokenPath(candidate.path);
    if (address === undefined || address.embedded !== undefined) return [];
    const value = String(tokens[address.token]?.value);
    return [
      address.span === undefined
        ? `${candidate.proposed.name}=${value}`
        : `${candidate.proposed.name}=${value}[${value.slice(address.span.start, address.span.end)}]`,
    ];
  });
}

describe("spans inside one token", () => {
  it("offers the parts of a path that carry the command's inputs, under those inputs' names", async () => {
    const { carrier, observed } = await recordCodexCommand(
      "codex-span-report",
      REPORT_INSTRUCTION,
      REPORT_COMMAND,
    );
    expect(inputOffers(REPORT_COMMAND, carrier.candidates ?? []).sort()).toEqual([
      "month=2025-03",
      "month=out/emea-2025-03/summary.csv[2025-03]",
      "region=emea",
      "region=out/emea-2025-03/summary.csv[emea]",
    ]);
    // A span candidate names positions and inputs, never the text it covers.
    const spans = (carrier.candidates ?? []).filter((candidate) => candidate.path.includes("span"));
    expect(spans).toHaveLength(2);
    expect(JSON.stringify(spans)).not.toMatch(/emea|2025/);

    // The published recording carries the spans, and binding them renders a command the shell runs.
    const recipe = recordCallsFromEvents(
      "codex-span-report",
      observed.map((entry) => projectEventToMetadataOnly(entry)),
    );
    const published = (recipe?.workflow.candidates ?? []).filter((candidate) =>
      candidate.path.includes("span"),
    );
    expect(published).toHaveLength(2);
    const tokens = tokenizeProgram("shell", REPORT_COMMAND);
    const values: Record<string, string> = { region: "apac", month: "2026-11" };
    const rendered = applyProgramTokenValues(
      REPORT_COMMAND,
      tokens,
      new Map(),
      "shell",
      undefined,
      published.map((candidate) => {
        const address = programTokenPath(candidate.path)!;
        return {
          token: address.token,
          span: address.span!,
          value: candidate.proposed.kind === "input" ? values[candidate.proposed.name]! : "",
        };
      }),
    );
    expect(
      spawnSync("sh", ["-c", `printf '%s\\n' ${rendered}`], { encoding: "utf8" }).stdout,
    ).toContain("out/apac-2026-11/summary.csv\n");
  });

  it("offers no span inside a token that carries a secret", async () => {
    const secret = "ghp_Z8r2kQ9vX4mN7pL1sT6wY3bC5dF0gH2jK8nR";
    const command = `report build --region emea --out out/emea-${secret}/summary.csv`;
    const { carrier } = await recordCodexCommand("codex-span-secret", REPORT_INSTRUCTION, command, [
      secret,
    ]);
    const tokens = tokenizeProgram("shell", command);
    const secretToken = tokens.findIndex((token) => token.raw.includes(secret));
    expect(
      (carrier.candidates ?? []).filter(
        (candidate) => programTokenPath(candidate.path)?.token === secretToken,
      ),
    ).toEqual([]);
  });
});
