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
import {
  SHELL_AND_CHAIN_SPLITTER_VERSION,
  isOptionalSetupSegment,
  splitShellAndChain,
} from "../src/shell-and-chain.js";

/** The report chains the monthly-report sessions ran, with their recorded values. */
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
    ["a redirection", "make > log && ls"],
    ["a descriptor redirection", "make 2>&1 && ls"],
    ["an input redirection", "sort < in && ls"],
    ["a pipe", "make | tee log && ls"],
    ["an or-list", "make || ls && ls"],
    ["a semicolon", "make; ls && ls"],
    ["a newline", "make &&\nls"],
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
    for (const text of ["mkdir out", "mkdir -p", "mkdir -p -m 700 out", "touch out", "cd out"])
      expect(isOptionalSetupSegment(text)).toBe(false);
  });
});

const bashAvailable = spawnSync("bash", ["-c", "true"]).status === 0;

describe.runIf(bashAvailable)("the allowlist against the commands bash runs", () => {
  /** External commands the corpus names: each is a stub that logs one line per run and succeeds. */
  const STUBS = ["make", "git", "npm", "mkdir", "ls", "touch", "tool", "reportctl"];
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
      spawnSync("/bin/bash", ["--norc", "--noprofile", "-c", source], {
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
  ];

  it.each(CORPUS)("splits %j only into the commands bash runs", (source) => {
    const chain = splitShellAndChain("bash", source);
    // Whatever splits is exactly the commands bash ran, one segment each.
    if (chain !== undefined) expect(bashRuns(source)).toBe(chain.segments.length);
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
  ])("behaves as the chain did: %s", (chain) => {
    const segments = splitShellAndChain("sh", chain)!.segments.map((segment) => segment.text);
    expect(run(segments)).toEqual(run([chain]));
  });
});
