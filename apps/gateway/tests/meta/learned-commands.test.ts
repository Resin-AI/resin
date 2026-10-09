import { describe, expect, it } from "vitest";
import {
  programCommands,
  programWritesFiles,
  summarizeLearnedCommands,
} from "../../src/meta/learned-commands.js";

describe("programCommands", () => {
  it.each([
    // Shapes of recorded programs from real learned tools.
    [
      `sleep 30; for i in $(seq 1 60); do out=$(gh pr checks 334 --repo example-org/example-repo 2>&1); s=$(echo "$out" | awk -F'\\t' '{print $2}' | sort | uniq -c | tr '\\n' ' '); case "$s" in *pending*) sleep 30;; *) break;; esac; done; echo "$out" | awk -F'\\t' '{print $1" | "$2}'`,
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

  it("never reads a command from a here-document body", () => {
    const program = [
      "psql -f - <<'SQL'",
      "canarytable_select * from x;",
      "canarytoken-abc | canarypipe",
      "SQL",
      "cat <<-EOF > out.txt",
      "\tcanaryindented run",
      "\tEOF",
      "stylua src",
      "cat <<< canaryherestring",
    ].join("\n");
    expect(programCommands(program)).toEqual(["psql", "stylua"]);
    expect(programCommands(`out=$(cat <<EOF\ncanaryinner arg\nEOF\n); vitest`)).toEqual(["vitest"]);
  });

  it.each([
    ["sudo -u canaryuser stylua src", ["stylua"]],
    ["sudo --user=canaryuser -E stylua", ["stylua"]],
    ["sudo -ucanaryuser stylua", ["stylua"]],
    ["env -u CANARY_OTHER -C canarydir CANARY_TOKEN=canaryvalue selene src", ["selene"]],
    ["timeout -s KILL -k 5 600 vitest", ["vitest"]],
    ["nice -n 10 cargo build", ["cargo build"]],
    ["nice -10 cargo build", ["cargo build"]],
    ["find . -name '*.ts' | xargs -I canaryrepl -P 4 eslint canaryrepl", ["eslint"]],
    ["stdbuf -oL pnpm test", ["pnpm test"]],
    ["npx -p canarypkg tsc", ["tsc"]],
    // An option a wrapper's grammar does not know may take an argument: name nothing.
    ["sudo --canary-unknown canaryvalue stylua", []],
    ["env -S 'canaryspell stylua'", []],
    ["command -v canarytool", []],
  ])("skips a wrapper's options and their arguments in %s", (program, expected) => {
    expect(programCommands(program)).toEqual(expected);
  });

  it("names only a CLI's own subcommands, never a value in the subcommand slot", () => {
    expect(programCommands("gh canaryrepo list; gh pr canaryaction")).toEqual(["gh", "gh pr"]);
    expect(programCommands("git canarybranch; make canarytarget; pnpm canaryscript")).toEqual([
      "git",
      "make",
      "pnpm",
    ]);
    expect(programCommands("aws s3 cp a b; aws canarysvc get-x; aws lambda canary-op")).toEqual([
      "aws s3 cp",
      "aws",
      "aws lambda",
    ]);
    expect(programCommands(`git "push" origin`)).toEqual(["git"]);
  });

  it("never names a quoted word, a path outside the workspace, or an expansion", () => {
    expect(programCommands(`"canaryquoted" run; 'canarysingle'`)).toEqual([]);
    expect(programCommands("python3 /home/canaryuser/x.py; bash ../canary.sh")).toEqual([]);
    expect(programCommands("python3 ~/canary.py; $CANARY_BIN run; ${CANARY} x")).toEqual([]);
    expect(programCommands("/opt/canary/bin/vitest run")).toEqual(["vitest"]);
  });

  it("drops any command that names a private value", () => {
    expect(
      programCommands("canarytool run; python3 scripts/canary-x.py; stylua; gh pr view", [
        "canarytool",
        "canary-x",
        "view",
      ]),
    ).toEqual(["stylua"]);
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

describe("programWritesFiles", () => {
  it.each([
    ["rm -rf target && cargo test", true],
    ["mkdir -p out; cp a out/", true],
    ["sed -i 's/a/b/' file.txt", true],
    ["FOO=1 /bin/rm x", true],
    ["cargo test 2>&1 | tail -20", false],
    ["sed 's/a/b/' file.txt | grep b", false],
    ["echo rm", false],
    ['git commit -m "rm everything"', false],
  ])("%j → %j", (program, expected) => {
    expect(programWritesFiles(program)).toBe(expected);
  });
});
