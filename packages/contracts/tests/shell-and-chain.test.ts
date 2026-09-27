import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SHELL_AND_CHAIN_SPLITTER_VERSION, splitShellAndChain } from "../src/shell-and-chain.js";

const texts = (shell: string, source: string) =>
  splitShellAndChain(shell, source)?.segments.map((segment) => segment.text);

describe("splitting a shell && chain", () => {
  it.each([
    [
      "mkdir -p out/EMEA-2025-03 && ./reportctl extract --region EMEA --out out/EMEA-2025-03/orders.csv && ./reportctl render out/EMEA-2025-03",
      [
        "mkdir -p out/EMEA-2025-03",
        "./reportctl extract --region EMEA --out out/EMEA-2025-03/orders.csv",
        "./reportctl render out/EMEA-2025-03",
      ],
    ],
    [
      "./reportctl render out/a&&./reportctl validate out/a",
      ["./reportctl render out/a", "./reportctl validate out/a"],
    ],
    ["echo \"a && b\" && echo 'c && d'", ['echo "a && b"', "echo 'c && d'"]],
    ["echo a\\&\\&b && true", ["echo a\\&\\&b", "true"]],
    ["make build 2>&1 && make test", ["make build 2>&1", "make test"]],
    ["LANG=C sort a > b && wc -l b", ["LANG=C sort a > b", "wc -l b"]],
    ['echo "$HOME" && ls', ['echo "$HOME"', "ls"]],
  ])("splits %j at its top-level && only", (source, expected) => {
    const chain = splitShellAndChain("bash", source);
    expect(chain?.version).toBe(SHELL_AND_CHAIN_SPLITTER_VERSION);
    expect(chain?.segments.map((segment) => segment.text)).toEqual(expected);
    for (const segment of chain!.segments)
      expect(source.slice(segment.start, segment.end)).toBe(segment.text);
  });

  it.each([
    ["one command", "./reportctl render out/a"],
    ["a command substitution", "mkdir -p $(date +%F) && ls"],
    ["a quoted command substitution", 'echo "$(date)" && ls'],
    ["backticks", "echo `date` && ls"],
    ["a process substitution in", "diff <(ls a) b && ls"],
    ["a process substitution out", "tee >(wc -l) < a && ls"],
    ["a subshell", "(cd a && make) && ls"],
    ["a brace group", "{ make; } && ls"],
    ["a parameter expansion in braces", "echo ${HOME} && ls"],
    ["a background job", "make & && ls"],
    ["a trailing background job", "make && ls &"],
    ["a pipe", "make | tee log && ls"],
    ["an or-list", "make || true && ls"],
    ["a semicolon", "make; ls && ls"],
    ["a newline", "make &&\nls"],
    ["a comment", "make && ls # done"],
    ["a heredoc", "cat <<EOF > a && ls\nx\nEOF"],
    ["a herestring", "cat <<< x && ls"],
    ["a line continuation", "make \\\n && ls"],
    ["an unterminated quote", "echo 'a && ls"],
    ["an empty segment", "make && && ls"],
    ["the last exit status", "make && echo $?"],
    ["the last background pid", "make && echo $!"],
    ["the last argument", "make && echo $_"],
    ["pipe statuses", "make && echo ${PIPESTATUS[0]}"],
    ["a bare assignment", "OUT=out/a && ls $OUT"],
    ["a compound command", "if true && ls"],
    ["a negation", "! grep x a && ls"],
  ])("never splits %s", (_, source) => {
    expect(splitShellAndChain("bash", source)).toBeUndefined();
  });

  it.each([
    "export",
    "unset",
    "set",
    "shopt",
    "alias",
    "source",
    ".",
    "exec",
    "trap",
    "umask",
    "ulimit",
    "cd",
    "pushd",
    "popd",
  ])("never splits a chain with a segment running %s", (builtin) => {
    expect(splitShellAndChain("bash", `make && ${builtin} x && ls`)).toBeUndefined();
    expect(splitShellAndChain("bash", `${builtin} x && ls`)).toBeUndefined();
    expect(splitShellAndChain("bash", `make && builtin ${builtin} x`)).toBeUndefined();
  });

  it("splits only POSIX shells", () => {
    for (const shell of ["bash", "sh", "zsh", "dash"])
      expect(texts(shell, "a && b")).toEqual(["a", "b"]);
    for (const shell of ["powershell", "pwsh", "python", "fish"])
      expect(splitShellAndChain(shell, "a && b")).toBeUndefined();
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
    "mkdir -p out/EMEA-2025-03 && printf 'a\\n' > out/EMEA-2025-03/orders.csv && wc -l out/EMEA-2025-03/orders.csv",
    "LANG=C printf 'b\\na\\n' > in && LANG=C sort in > sorted && cat sorted",
    "echo first > log 2>&1 && false && echo never > never",
    'echo "a && b" > quoted && cat quoted',
  ])("behaves as the chain did: %s", (chain) => {
    const segments = splitShellAndChain("sh", chain)!.segments.map((segment) => segment.text);
    expect(run(segments)).toEqual(run([chain]));
  });
});
