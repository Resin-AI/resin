import { describe, expect, it } from "vitest";
import { programCommands, summarizeLearnedCommands } from "../../src/meta/learned-commands.js";

describe("programCommands", () => {
  it.each([
    // Shapes of recorded programs from real learned tools.
    [
      `sleep 30; for i in $(seq 1 60); do out=$(gh pr checks 334 --repo Resin-AI/resin-cloud 2>&1); s=$(echo "$out" | awk -F'\\t' '{print $2}' | sort | uniq -c | tr '\\n' ' '); case "$s" in *pending*) sleep 30;; *) break;; esac; done; echo "$out" | awk -F'\\t' '{print $1" | "$2}'`,
      ["gh pr checks"],
    ],
    [
      `cd {working_directory} && timeout 600 npx vitest {test_name_filter} {test_file_path} --reporter=verbose --silent=false 2>&1 | grep -E "perf|✓|×|Duration"`,
      ["vitest"],
    ],
    [
      "stylua --check src scripts tests 2>&1 | tail -20; selene src scripts tests 2>&1 | tail -5",
      ["stylua", "selene"],
    ],
    [
      "for n {loop_keyword} {first_issue} {second_issue}; do gh issue view $n -R {repository} --comments; echo =========; done",
      ["gh issue view"],
    ],
    ["python3 scripts/manifest.py add {manifest_entry}", ["python3 scripts/manifest.py"]],
    ["omp models 2>/dev/null | grep -iE {model_pattern} | head -20", ["omp models"]],
    [
      "git add src && git commit -m 'Update: a | b; c' && git push origin HEAD",
      ["git add", "git commit", "git push"],
    ],
    ["pnpm exec vitest run src/a.test.ts > /tmp/out.txt", ["vitest"]],
    ["CI=1 pnpm test -- --run", ["pnpm test"]],
    ["lune run scripts/test.luau --suite Highway 2>&1 | tail -8", ["lune run"]],
  ])("names what %s runs", (program, expected) => {
    expect(programCommands(program)).toEqual(expected);
  });

  it("names no command for plumbing alone or an inline interpreter program", () => {
    expect(programCommands("grep -c pattern file.txt | wc -l")).toEqual([]);
    expect(programCommands(`python3 -c "print(1)"`)).toEqual([]);
  });

  it("does not split on separators inside quotes", () => {
    expect(programCommands(`npx tsc --noEmit 2>&1 | grep -E "error|FAIL|Tests"`)).toEqual(["tsc"]);
  });
});

describe("summarizeLearnedCommands", () => {
  it("ranks commands by how many tools run them, counting each tool once", () => {
    expect(
      summarizeLearnedCommands([
        ["stylua", "selene"],
        ["vitest"],
        ["vitest", "vitest"],
        ["gh pr checks"],
        ["stylua", "selene", "lune run"],
        ["vitest"],
      ]),
    ).toEqual(["vitest", "stylua", "selene", "gh pr checks", "lune run"]);
  });

  it("keeps at most the limit", () => {
    expect(summarizeLearnedCommands([["a", "b", "c"]], 2)).toEqual(["a", "b"]);
  });
});
