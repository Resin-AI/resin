/**
 * The POSIX tokenizer applies the same code-evaluation policy as the PowerShell one: a value that a
 * second parser would read as code is never bindable.
 */
import { describe, expect, it } from "vitest";
import { posixCommandWords } from "../src/code-evaluation.js";
import { tokenizeProgram } from "../src/program-tokens.js";

const bindable = (source: string): string[] =>
  tokenizeProgram("shell", source)
    .filter((token) => token.bindable)
    .map((token) => token.raw);

describe("POSIX programs that evaluate code", () => {
  it.each([
    ["eval", "eval 'echo emea'"],
    ["a variable a later eval runs", "cd /tmp; x='echo emea'; eval \"$x\""],
    ["trap", "trap 'rm -f out/emea.txt' EXIT; ./report --region emea"],
    ["ssh, which joins its arguments into a remote command line", "ssh host echo emea"],
    ["ssh behind sudo -u", "sudo -u root ssh host echo emea"],
    ["watch", "watch -n 5 ls emea"],
    ["sudo -s", "sudo -s ls emea"],
    ["env -S", "env -S 'ls emea'"],
    ["pwsh -Command", "pwsh -Command 'Write-Output emea' next"],
    ["cmd.exe /c", "cmd.exe /c echo emea"],
    ["cmd //c from Git Bash", "cmd //c echo emea"],
    ["wsl", "wsl ls emea"],
    ["a batch file", "./report.bat emea"],
  ])("binds nothing in a program that runs %s", (_, source) => {
    expect(bindable(source)).toEqual([]);
  });

  it("keeps a code runner's code word unbound, whatever flags it combines", () => {
    for (const source of [
      "bash -lc 'echo emea' arg0 data.csv",
      "python3 -Bc 'print(1)' data.csv",
      "perl -ne 'print' data.csv",
      "su -c 'echo emea' data.csv",
      "flock /tmp/lock -c 'echo emea' data.csv",
    ]) {
      const words = bindable(source);
      expect(
        words.some((word) => word.includes("echo") || word.includes("print")),
        source,
      ).toBe(false);
      expect(words, source).toContain("data.csv");
    }
  });

  it("binds no assignment a code runner can read, but keeps other commands' data", () => {
    const words = bindable("cd /tmp; X=emea bash -c 'echo $X' && ./report --region emea");
    expect(words).not.toContain("X=emea");
    expect(words).not.toContain("'echo $X'");
    expect(words).toEqual(expect.arrayContaining(["/tmp", "--region", "emea"]));
    // An assignment-shaped argument is data until the program also runs code that can read it.
    expect(bindable("make build REGION=emea")).toContain("REGION=emea");
    expect(bindable("make build REGION=emea && python3 -c 'import os'")).not.toContain(
      "REGION=emea",
    );
  });

  it("counts an evaluator only in command position", () => {
    expect(bindable("npm run watch -- --region emea")).toContain("emea");
    expect(bindable("grep eval src/main.c")).toContain("src/main.c");
    expect(
      posixCommandWords(["LANG=C", "sudo", "-u", "root", "timeout", "5", "ssh", "host"]),
    ).toEqual(["sudo", "timeout", "ssh"]);
  });
});
