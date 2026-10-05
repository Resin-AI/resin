/**
 * Values a later command uses that an earlier command printed: a pull request number in the URL
 * `gh pr create` prints, a commit in a JSON field or `head=` pair, a run id in a table cell. Each is
 * offered as an extract on the printing call, located by the text that names its position. Values
 * that only coincide (a port in a help text, a number inside a timestamp, a repository name or flag
 * an earlier output echoed) are not.
 */
import { extractPrintedValue, tokenizeProgram } from "@resin/contracts";
import { describe, expect, it } from "vitest";
import {
  type DerivedExtract,
  deriveNativeCalls,
} from "../../src/analytics/native-argument-derivation.js";
import { RESIN_PROCESS_RUNTIME } from "../../src/analytics/workflow-call-recorder.js";

const SHA = "4f1c2e9a7b3d5f60718293a4b5c6d7e8f9012345";
const RUN = "48213377905";

function shell(index: number, command: string, result?: string) {
  return {
    callId: `call_${index}`,
    stepId: `step${index}`,
    toolName: "bash",
    runtime: RESIN_PROCESS_RUNTIME,
    arguments: { command },
    ...(result === undefined ? {} : { result }),
    program: { kind: "shell" as const, argument: "command" },
  };
}

type Call = ReturnType<typeof shell>;

/** Each extract as [consuming step, the text it binds, producing step, the locator's `before`]. */
function described(calls: Call[], extracts: DerivedExtract[]) {
  return extracts.map((extract) => {
    const call = calls.find((entry) => entry.stepId === extract.stepId)!;
    const token = tokenizeProgram("shell", call.arguments.command)[extract.path[1] as number]!;
    const text =
      extract.path[2] === "span"
        ? String(token.value).slice(extract.path[3] as number, extract.path[4] as number)
        : token.value;
    const producer = calls.find((entry) => entry.stepId === extract.producerStepId)!;
    // Every locator finds exactly the bound text in the producer's recorded output.
    expect(extractPrintedValue(producer.result!, extract.locator)).toBe(text);
    return [extract.stepId, text, extract.producerStepId, extract.locator.before];
  });
}

describe("a value an earlier command printed", () => {
  it("reads a pull request number from the URL path, named by its segment, not the repository", () => {
    const calls = [
      shell(
        0,
        "gh pr create --repo acme/widgets --base main --head fix/login --title 'Fix login' --body-file body.md",
        "https://github.com/acme/widgets/pull/107\n\n\nWall time: 2.12 seconds",
      ),
      shell(1, "gh pr checks 107 --repo acme/widgets --watch", "build\tpass\t1m2s\n"),
      shell(2, "gh pr merge 107 --repo acme/widgets --squash", "merged\n"),
    ];
    expect(described(calls, deriveNativeCalls(calls).extracts)).toEqual([
      ["step1", "107", "step0", "/pull/"],
      ["step2", "107", "step0", "/pull/"],
    ]);
  });

  it("counts an earlier mention only where the value stands whole, not inside a longer value", () => {
    const calls = [
      // A session file name and a log path holding `473` inside other values.
      shell(0, "ls sessions/2026-10-04T14-26-46-473Z_01a1.jsonl /tmp/pr473.log", "ok\n"),
      shell(1, "gh pr create --fill", "https://github.com/acme/widgets/pull/473\n"),
      shell(2, "gh pr merge 473 --squash", "merged\n"),
    ];
    expect(described(calls, deriveNativeCalls(calls).extracts)).toEqual([
      ["step2", "473", "step1", "/pull/"],
    ]);
  });

  it("does not read a value an earlier call was given whole", () => {
    const calls = [
      shell(0, "gh pr view 473 --json title", '{"title":"x"}\n'),
      shell(1, "gh pr list --json number", '[{"number": 473}]\n'),
      shell(2, "gh pr merge 473 --squash", "merged\n"),
    ];
    expect(deriveNativeCalls(calls).extracts).toEqual([]);
  });

  it("reads a short number only from a structured position, a long run id from prose too", () => {
    const calls = [
      shell(0, "pnpm local --help", "Usage: pnpm local [--port 3200] [--no-stripe]\n"),
      shell(1, "pnpm local --port 3200", "ready\n"),
      shell(2, "./watch-run.sh", `run ${RUN}\nexit=0\n`),
      shell(3, `gh run view ${RUN} --json conclusion`, '{"conclusion":"success"}\n'),
      shell(4, "gh pr view --json number,title", '{"number": 214, "title": "Fix login"}\n'),
      shell(5, "gh pr merge 214 --squash", "merged\n"),
    ];
    expect(described(calls, deriveNativeCalls(calls).extracts)).toEqual([
      ["step3", RUN, "step2", "run "],
      ["step5", "214", "step4", '"number": '],
    ]);
  });

  it("reads a commit from a key=value pair and a JSON field into a later option", () => {
    const calls = [
      shell(
        0,
        "gh pr view 107 --json headRefOid,state --jq '\"head=\\(.headRefOid) state=\\(.state)\"'",
        `head=${SHA} state=OPEN\n`,
      ),
      shell(1, `gh pr merge 107 --squash --match-head-commit ${SHA}`, `{"merge":"${SHA}"}\n`),
    ];
    expect(described(calls, deriveNativeCalls(calls).extracts)).toEqual([
      ["step1", SHA, "step0", "head="],
    ]);
  });

  it("binds the value of an inline field option as a span, and offers no input over that token", () => {
    const dispatch = `gh workflow run release.yml -f commit_sha=${SHA} -f ci_run_id=${RUN}`;
    const calls = [
      shell(0, "gh pr merge 301 --squash", `{"merge":"${SHA}","state":"MERGED"}\n`),
      // `@tsv` rows: the run id is the first cell of the first row.
      shell(
        1,
        "gh run list --workflow ci.yml --limit 2 --json databaseId,headSha --jq '.[] | [.databaseId, .headSha[0:7]] | @tsv'",
        `${RUN}\t4f1c2e9\nunrelated text\n`,
      ),
      shell(2, dispatch),
    ];
    const derivation = deriveNativeCalls(calls, new Set(["release.yml"]));
    expect(described(calls, derivation.extracts)).toEqual([
      ["step2", SHA, "step0", '"merge":"'],
      ["step2", RUN, "step1", ""],
    ]);
    const tokens = tokenizeProgram("shell", dispatch);
    const sha = tokens.findIndex((token) => token.value === `commit_sha=${SHA}`);
    expect(derivation.extracts[0]!.path).toEqual(["tokens", sha, "span", 11, 51]);
    expect(derivation.extracts[0]!.evidence).toEqual({
      tokens: tokens.length,
      token: sha,
      span: [11, 51],
    });
    const overlapping = derivation.candidates.filter(
      (candidate) =>
        candidate.stepId === "step2" &&
        candidate.path[0] === "tokens" &&
        derivation.extracts.some((extract) => extract.path[1] === candidate.path[1]),
    );
    expect(overlapping).toEqual([]);
  });

  it("reads a run id from a table cell at the start of a later line", () => {
    const calls = [
      shell(
        0,
        "curl -s https://api.example.test/health; gh run list --limit 2 --json databaseId,status --jq '.[] | [.databaseId, .status] | @tsv'",
        `{"status":"ok"}\napi invocations=5 errors=0\n${RUN}\tin_progress\n48213311111\tcompleted\n`,
      ),
      shell(1, `gh run watch ${RUN} --interval 30`, "done\n"),
    ];
    expect(described(calls, deriveNativeCalls(calls).extracts)).toEqual([
      ["step1", RUN, "step0", "\n"],
    ]);
  });

  it("never reads a flag or a name made only of letters from an output that echoed it", () => {
    const calls = [
      shell(
        0,
        "grep -h 'gh run watch' notes/*.md",
        "gh run watch 123 --repo acme-corp/widgets --exit-status\n",
      ),
      shell(1, "gh run watch 456 --repo acme-corp/widgets --exit-status", "done\n"),
    ];
    expect(deriveNativeCalls(calls).extracts).toEqual([]);
  });
});
