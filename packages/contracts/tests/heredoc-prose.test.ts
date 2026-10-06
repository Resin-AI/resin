import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type EmbeddedProgram,
  applyProgramTokenValues,
  bindProgramToken,
  embeddedPrograms,
  programTokenPath,
  programTokenValueAt,
  renderEmbeddedProgramTokenValue,
  renderProgramTokenValue,
  tokenizeProgram,
} from "../src/program-tokens.js";

/**
 * The literal body of a quoted-delimiter heredoc a command reads as data — a commit message, a PR
 * body — is one bindable prose token: the one token of an embedded `text` program, addressed
 * `["tokens", anchor, "embedded", 0]`, kind `string` with `quote: "heredoc"`. Top-level tokens are
 * untouched, so no plan's token index moves.
 */

function prose(source: string): EmbeddedProgram[] {
  return embeddedPrograms(source).filter((program) => program.language === "text");
}

function only(source: string): EmbeddedProgram {
  const programs = prose(source);
  expect(programs, source).toHaveLength(1);
  return programs[0]!;
}

function bind(source: string, value: string, program: EmbeddedProgram = only(source)): string {
  return applyProgramTokenValues(
    source,
    tokenizeProgram("shell", source),
    new Map(),
    "shell",
    new Map([[program.anchor, new Map([[0, value]])]]),
  );
}

const COMMIT =
  "git commit -q -F - <<'EOF'\nFix the parser\n\nIt reads \"quotes\" (and parens).\nEOF\ngit push origin feature-x";
const PR_BODY_FILE =
  'gh pr create --title "Fix the parser" --body-file - <<"EOF"\n## Summary\n- reads quotes\nEOF';
const TAG = "git tag -a v1.2.0 -F - <<\\EOF\nRelease 1.2.0\nEOF";
const TABBED = "cat <<-'EOF'\n\tIndented\n\t\tdeeper\n\n\tEOF\necho done";
const PR_SUBSTITUTED =
  'gh pr create --title "Fix the parser" --body "$(cat <<\'EOF\'\n## Summary\n- reads `quotes` (and parens)\n\nEOF\n)" --base main';
const PR_ASSIGNED = "gh pr edit 12 --body=\"$(cat <<'EOF'\nUpdated body\nEOF\n)\"";
const NOTES =
  "cat > notes/release.md <<'EOF'\nRelease notes\nEOF\ngh release create v1.2.0 --notes-file notes/release.md";

describe("heredoc prose", () => {
  it("is one bindable string token marked quote heredoc, at each quoted-delimiter form", () => {
    const cases: Array<[string, string, string, EmbeddedProgram["context"]]> = [
      [COMMIT, "'EOF'", 'Fix the parser\n\nIt reads "quotes" (and parens).', "literal-heredoc"],
      [PR_BODY_FILE, '"EOF"', "## Summary\n- reads quotes", "literal-heredoc"],
      [TAG, "\\EOF", "Release 1.2.0", "literal-heredoc"],
      [TABBED, "-'EOF'", "Indented\ndeeper\n", "literal-heredoc"],
      [
        PR_SUBSTITUTED,
        "\"$(cat <<'EOF'\n## Summary\n- reads `quotes`",
        "## Summary\n- reads `quotes` (and parens)\n",
        "substituted-heredoc",
      ],
      [
        PR_ASSIGNED,
        "--body=\"$(cat <<'EOF'\nUpdated body\nEOF\n)\"",
        "Updated body",
        "substituted-heredoc",
      ],
      [NOTES, "'EOF'", "Release notes", "literal-heredoc"],
    ];
    for (const [source, anchor, value, context] of cases) {
      const program = only(source);
      const tokens = tokenizeProgram("shell", source);
      expect(tokens[program.anchor]!.raw.startsWith(anchor), source).toBe(true);
      expect(program.context, source).toBe(context);
      expect(program.tokens, source).toHaveLength(1);
      const [token] = program.tokens;
      expect(token, source).toMatchObject({
        kind: "string",
        quote: "heredoc",
        bindable: true,
        value,
      });
      expect(source.slice(token!.start, token!.end)).toBe(token!.raw);
      expect(source.slice(program.start, program.end)).toBe(token!.raw);
      const address = programTokenPath(["tokens", program.anchor, "embedded", 0]);
      expect(programTokenValueAt("shell", source, address!), source).toBe(value);
      // The recorded value renders the recorded program, byte for byte.
      expect(bind(source, value), source).toBe(source);
      // No top-level token is prose.
      expect(tokens.some((each) => each.quote === "heredoc")).toBe(false);
    }
  });

  it("binds the PR body of a merge-then-view plan", () => {
    const source =
      'gh pr merge 42 --squash --delete-branch --subject "Fix the parser (#42)" --body "$(cat <<\'EOF\'\nReads quoted words.\n\nCo-authored-by: Someone <someone@example.com>\nEOF\n)" 2>&1 | tail -n 3; gh pr view 42 --json state,mergedAt';
    const program = only(source);
    expect(program.context).toBe("substituted-heredoc");
    expect(tokenizeProgram("shell", source)[program.anchor]!.raw.startsWith('"$(cat')).toBe(true);
    expect(program.tokens[0]!.value).toBe(
      "Reads quoted words.\n\nCo-authored-by: Someone <someone@example.com>",
    );
    expect(bind(source, "Other body")).toBe(
      'gh pr merge 42 --squash --delete-branch --subject "Fix the parser (#42)" --body "$(cat <<\'EOF\'\nOther body\nEOF\n)" 2>&1 | tail -n 3; gh pr view 42 --json state,mergedAt',
    );
  });

  it("leaves every top-level token where it was", () => {
    // Indexes as tokenizeProgram has always read them: the heredoc body's own tokens included.
    const commit = tokenizeProgram("shell", COMMIT);
    expect(commit.map((token) => token.raw)).toEqual([
      "git",
      "commit",
      "-q",
      "-F",
      "-",
      "<<",
      "'EOF'",
      "Fix",
      "the",
      "parser",
      "It",
      "reads",
      '"quotes"',
      "(",
      "and",
      "parens",
      ")",
      ".",
      "EOF",
      "git",
      "push",
      "origin",
      "feature-x",
    ]);
    expect(commit[22]).toMatchObject({ raw: "feature-x", bindable: true, value: "feature-x" });
    const substituted = tokenizeProgram("shell", PR_SUBSTITUTED);
    expect(substituted.map((token) => token.raw).slice(-2)).toEqual(["--base", "main"]);
    expect(substituted).toHaveLength(9);
  });

  it("binds through bindProgramToken as an embedded hole", () => {
    const program = only(PR_SUBSTITUTED);
    const template = bindProgramToken(
      { type: "literal", value: PR_SUBSTITUTED },
      "shell",
      program.anchor,
      { type: "input", name: "body" },
      0,
    );
    expect(template).toMatchObject({
      type: "program",
      holes: [{ token: program.anchor, embedded: 0, binding: { type: "input", name: "body" } }],
    });
    // A span of the body binds like a span of any string token.
    const rendered = applyProgramTokenValues(
      PR_SUBSTITUTED,
      tokenizeProgram("shell", PR_SUBSTITUTED),
      new Map(),
      "shell",
      undefined,
      [{ token: program.anchor, embedded: 0, span: { start: 3, end: 10 }, value: "Overview" }],
    );
    expect(rendered).toContain("## Overview\n- reads");
  });

  it("replaces the body verbatim, keeping `<<-` indentation", () => {
    expect(bind(COMMIT, "New title\n\nBody line")).toBe(
      "git commit -q -F - <<'EOF'\nNew title\n\nBody line\nEOF\ngit push origin feature-x",
    );
    expect(bind(TABBED, "one\n\ntwo")).toBe("cat <<-'EOF'\n\tone\n\n\ttwo\n\tEOF\necho done");
    expect(bind(PR_SUBSTITUTED, "Short")).toBe(
      'gh pr create --title "Fix the parser" --body "$(cat <<\'EOF\'\nShort\nEOF\n)" --base main',
    );
    // An empty value is one empty line; a trailing line break is a trailing empty line.
    expect(bind(TAG, "")).toBe("git tag -a v1.2.0 -F - <<\\EOF\n\nEOF");
    expect(bind(TAG, "a\n")).toBe("git tag -a v1.2.0 -F - <<\\EOF\na\n\nEOF");
  });

  it("refuses a value that would end the heredoc or change how the program parses", () => {
    const refused = (source: string, value: unknown) =>
      expect(() => bind(source, value as string), `${source} ← ${JSON.stringify(value)}`).toThrow();
    for (const source of [COMMIT, PR_BODY_FILE, TAG, TABBED, PR_SUBSTITUTED]) {
      refused(source, "before\nEOF\nrm -rf ~");
      refused(source, "EOF");
      refused(source, "nul\0byte");
      refused(source, "carriage\r\nreturn");
      refused(source, 42);
    }
    refused(TABBED, "\tstarts with a tab");
    // dash drops a byte of a non-ASCII character right after a delimiter prefix.
    refused(COMMIT, "Eé");
    refused(COMMIT, "fine\nEOFé");
    expect(bind(COMMIT, "é\nxEé\nEOF é")).toContain("é\nxEé\nEOF é\nEOF");
    refused(TABBED, "fine\n\tEOF");
    // Inside $( … ): bash ≥ 4.2 ends the heredoc at a delimiter-led line holding `)`; bash ≤ 4.4
    // joins a line ending in `\`; bash 3.2 scans the substitution for its `)` with quotes paired.
    for (const value of [
      "EOF)",
      "EOF )",
      'EOF")',
      "EOFx) and more",
      "trailing\\",
      "it's",
      "lone ) paren",
      "lone ( paren",
      "lone ` tick",
      'lone " quote',
      "${HOME",
      "$'ansi'",
      '$"locale"',
      ')"\nrm -rf ~\n"$(',
    ]) {
      refused(PR_SUBSTITUTED, value);
      // The same text is plain prose fed to standard input.
      expect(bind(COMMIT, value)).toContain(value);
    }
    expect(() => renderProgramTokenValue(only(COMMIT).tokens[0]!, "text", "shell")).toThrow(
      /heredoc/,
    );
    const code = embeddedPrograms("python3 - <<'EOF'\nprint('x')\nEOF")[0]!;
    expect(() =>
      renderEmbeddedProgramTokenValue(code, { ...only(COMMIT).tokens[0]! }, "x"),
    ).toThrow(/heredoc/);
  });

  it("is never found where the body could be code or its extent is not certain", () => {
    for (const source of [
      // Unquoted: the shell expands the body.
      "git commit -F - <<EOF\nmsg\nEOF",
      // Code readers, directly, behind a wrapper, or down the pipe.
      "python3 - <<'EOF'\nprint(1)\nEOF",
      "bash <<'EOF'\necho hi\nEOF",
      "sudo -u app sh <<'EOF'\necho hi\nEOF",
      "cat <<'EOF' | sh\necho hi\nEOF",
      "cat <<'EOF' | xargs rm\na\nEOF",
      "ssh host-a <<'EOF'\nuptime\nEOF",
      "docker exec -i web psql <<'EOF'\nselect 1;\nEOF",
      "at now <<'EOF'\necho hi\nEOF",
      "$EDITOR <<'EOF'\nmsg\nEOF",
      // A file that is a script, or that a later command runs or makes runnable.
      "cat > deploy.sh <<'EOF'\necho hi\nEOF",
      "cat > job <<'EOF'\necho hi\nEOF\nchmod +x job",
      "cat > job <<'EOF'\necho hi\nEOF\n./job",
      "tee job <<'EOF'\necho hi\nEOF\nbash job",
      "cat > \"$OUT\" <<'EOF'\nmsg\nEOF",
      "cat > notes <<'EOF'\n#!/bin/sh\necho hi\nEOF",
      // A program that evaluates code binds nothing.
      "eval \"$X\"; git commit -F - <<'EOF'\nmsg\nEOF",
      'BODY="$(cat <<\'EOF\'\nmsg\nEOF\n)"; python3 -c "$BODY"',
      // Stored in a variable where a code reader could run it.
      'BODY="$(cat <<\'EOF\'\nmsg\nEOF\n)"\necho "$BODY" | sh',
      "read -r -d '' X <<'EOF'\nmsg\nEOF\nsh run",
      // Nested, unquoted or partial substitutions.
      "( git commit -F - <<'EOF'\nmsg\nEOF\n)",
      "echo $(cat <<'EOF'\nmsg\nEOF\n)",
      "gh pr create --body \"Intro $(cat <<'EOF'\nmsg\nEOF\n)\"",
      "gh pr create --body \"$(cat <<'EOF'\nmsg\nEOF\n) trailer\"",
      "bash -c \"$(cat <<'EOF'\necho hi\nEOF\n)\"",
      "x=`cat`; gh pr create --body \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
      // A recorded line bash would end the substituted heredoc at.
      "gh pr create --body \"$(cat <<'EOF'\nEOF )\nmore\nEOF\n)\"",
      // Empty or unterminated.
      "git commit -F - <<'EOF'\nEOF",
      "git commit -F - <<'EOF'\nmsg",
    ]) {
      expect(prose(source), source).toEqual([]);
    }
  });

  it("stops after a substituted body the top-level lexer misreads", () => {
    // The lexer reads a `"…"` word to its next `"`: past this body, its token boundaries are not the
    // shell's, so the later heredoc is not offered. The misread body itself is.
    const source =
      "gh pr create --body \"$(cat <<'A'\nsay \"hi\nA\n)\"\ngit commit -F - <<'B'\nmsg\nB";
    expect(prose(source).map((program) => program.tokens[0]!.value)).toEqual(['say "hi']);
    const clean =
      "gh pr create --body \"$(cat <<'A'\nsay hi\nA\n)\"\ngit commit -F - <<'B'\nmsg\nB";
    expect(prose(clean).map((program) => program.tokens[0]!.value)).toEqual(["say hi", "msg"]);
  });
});

/** POSIX shells on this machine; bash and dash parse `$( … )` heredocs differently. */
const SHELLS = ["bash", "dash", "sh"].filter(
  (shell) => spawnSync(shell, ["-c", "exit 0"]).status === 0,
);

function run(shell: string, program: string, cwd: string): string {
  const result = spawnSync(shell, ["-c", program], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-home" },
  });
  expect(result.status, `${shell}: ${program}\n${result.stderr}`).toBe(0);
  return result.stdout;
}

/** Hostile prose every form must deliver verbatim. */
const HOSTILE_PAIRED = [
  "say \"hi\" and 'bye'",
  "$HOME and $(touch PWNED) and `touch PWNED`",
  "back\\slash, \\\\ and \\n",
  "(parens) ((nested)) $((1+2))",
  "EOF \n EOF\nEOF;\nEOFX\n\tEOF\nXEOF",
  "# not a comment; && || | > out < in * ? ~",
  "unicode ✓ — 日本語 🎉 é",
  "a\n\n\nb",
  "",
];
/** Hostile prose only standard input takes: a `$( … )` substitution in bash 3.2 or 4.x would not. */
const HOSTILE_UNPAIRED = [
  "it's",
  "lone ) paren",
  ')"\ntouch PWNED\n"$(',
  'lone ( and ` and "',
  "EOF)\nEOF )",
  "line ends in \\",
  "${HOME",
];

describe.skipIf(SHELLS.length === 0)("heredoc prose in real shells", () => {
  const directory = mkdtempSync(join(tmpdir(), "resin-heredoc-prose-"));
  const pwned = () => existsSync(join(directory, "PWNED"));

  it("delivers a bound body to standard input exactly, in every quoted form", () => {
    const forms = [
      "cat <<'EOF'\nrecorded\nEOF",
      'cat <<"EOF"\nrecorded\nEOF',
      "cat <<\\EOF\nrecorded\nEOF",
      "cat <<-'EOF'\n\trecorded\n\tEOF",
      "cat -- - <<'EOF' | cat\nrecorded\nEOF",
    ];
    try {
      for (const form of forms) {
        for (const value of [...HOSTILE_PAIRED, ...HOSTILE_UNPAIRED]) {
          if (form.includes("<<-") && value.split("\n").some((line) => line.startsWith("\t"))) {
            continue;
          }
          const rendered = bind(form, value);
          for (const shell of SHELLS) {
            expect(run(shell, `${rendered}\necho END`, directory), `${shell}: ${rendered}`).toBe(
              `${value}\nEND\n`,
            );
          }
        }
      }
      expect(pwned()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("delivers a bound body through \"$(cat <<'EOF' …)\" exactly", () => {
    const local = mkdtempSync(join(tmpdir(), "resin-heredoc-prose-"));
    const forms = [
      "printf '%s|' --body \"$(cat <<'EOF'\nrecorded\nEOF\n)\"",
      'printf \'%s|\' --body="$(cat <<"EOF"\nrecorded\nEOF\n)"',
      "printf '%s|' \"$(cat <<-'EOF'\n\trecorded\n\tEOF\n)\"",
      'BODY="$( cat<<\\EOF\nrecorded\nEOF\n\n  )"; printf \'%s|\' "$BODY"',
    ];
    try {
      for (const form of forms) {
        for (const value of HOSTILE_PAIRED) {
          if (form.includes("<<-") && value.split("\n").some((line) => line.startsWith("\t"))) {
            continue;
          }
          const rendered = bind(form, value);
          // Command substitution drops trailing line breaks; the value carries none here.
          const flag = form.includes("--body=")
            ? "--body="
            : form.includes("--body")
              ? "--body|"
              : "";
          for (const shell of SHELLS) {
            expect(run(shell, `${rendered}; echo END`, local), `${shell}: ${rendered}`).toBe(
              `${flag}${value}|END\n`,
            );
          }
        }
        for (const value of HOSTILE_UNPAIRED) {
          expect(() => bind(form, value), `${form} ← ${value}`).toThrow();
        }
      }
      expect(existsSync(join(local, "PWNED"))).toBe(false);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it("delivers every accepted random body exactly", () => {
    const local = mkdtempSync(join(tmpdir(), "resin-heredoc-prose-"));
    const pieces = [
      "a",
      " ",
      "\n",
      "'",
      '"',
      "`",
      "(",
      ")",
      "\\",
      "$",
      "{",
      "}",
      "#",
      ";",
      "|",
      "&",
      "<",
      ">",
      "*",
      "EOF",
      "\t",
      "é",
      "✓",
    ];
    // A fixed linear congruential sequence: the same bodies every run.
    let seed = 20261006;
    const next = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };
    const forms = [
      "cat <<'EOF'\nrecorded\nEOF",
      "printf '%s|' \"$(cat <<'EOF'\nrecorded\nEOF\n)\"",
    ];
    const accepted = [0, 0];
    try {
      for (let round = 0; round < 120; round += 1) {
        let value = "";
        for (let length = next(14); length > 0; length -= 1) value += pieces[next(pieces.length)];
        for (const [index, form] of forms.entries()) {
          let rendered: string;
          try {
            rendered = bind(form, value);
          } catch {
            continue;
          }
          accepted[index]! += 1;
          const expected = index === 0 ? `${value}\n` : `${value.replace(/\n+$/, "")}|`;
          for (const shell of SHELLS) {
            expect(run(shell, rendered, local), `${shell}: ${JSON.stringify(value)}`).toBe(
              expected,
            );
          }
        }
      }
      expect(existsSync(join(local, "PWNED"))).toBe(false);
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
    // Most bodies are fine prose for standard input; paired text passes inside $( … ) too.
    expect(accepted[0]).toBeGreaterThan(100);
    expect(accepted[1]).toBeGreaterThan(10);
  });
});
