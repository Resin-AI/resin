import { describe, expect, it } from "vitest";
import { isHarnessIntrospectionProgram } from "../src/harness-introspection.js";
import { powershellValueName } from "../src/powershell-tokens.js";
import {
  ProgramTokenizationError,
  applyProgramTokenValues,
  bindProgramToken,
  tokenizeProgram,
} from "../src/program-tokens.js";
import { type RecordedWorkflow, validateRecordedWorkflow } from "../src/recorded-workflow.js";
import {
  recordedPosixShell,
  recordedShellDialect,
  splitShellAndChain,
} from "../src/shell-and-chain.js";
import {
  CMD_NOT_LEARNABLE_REASON,
  UNPROVEN_SHELL_DIALECT_REASON,
  programNotLearnableReason,
  recordedProgramLanguage,
  shellDialectOfExecutable,
  windowsShellInvocation,
} from "../src/shell-dialects.js";

const EDITIONS = ["powershell", "pwsh"] as const;

/** Each token as `raw` with a `*` when bindable and `=value` when its value is known. */
function shape(source: string, edition: (typeof EDITIONS)[number] = "powershell"): string[] {
  return tokenizeProgram(edition, source).map(
    (token) =>
      `${token.kind}:${token.raw}${token.bindable ? "*" : ""}${
        typeof token.value === "string" && token.value !== token.raw ? `=${token.value}` : ""
      }`,
  );
}

function bindable(source: string, edition: (typeof EDITIONS)[number] = "powershell"): string[] {
  return tokenizeProgram(edition, source)
    .filter((token) => token.bindable)
    .map((token) => String(token.value));
}

describe("the PowerShell tokenizer", () => {
  it.each(EDITIONS)("reads a pipeline of commands in argument mode (%s)", (edition) => {
    expect(
      shape(
        "Get-Content -Path data/sales.csv | Select-Object -First 5 > out/head.txt; python report.py --region 'emea'",
        edition,
      ),
    ).toEqual([
      "word:Get-Content",
      "word:-Path",
      "word:data/sales.csv*",
      "operator:|",
      "word:Select-Object",
      "word:-First",
      "word:5*",
      "operator:>",
      "word:out/head.txt*",
      "operator:;",
      "word:python",
      "word:report.py*",
      "word:--region",
      "string:'emea'*=emea",
    ]);
  });

  it("decodes both quote styles exactly and refuses expansion", () => {
    expect(bindable('Write-Output \'it\'\'s\' "tab`there" "say ""hi"""')).toEqual([
      "it's",
      "tab\there",
      'say "hi"',
    ]);
    // Variables, environment variables and subexpressions are never bound.
    expect(bindable('Write-Output "$name" $env:USERPROFILE "${x}" plain')).toEqual(["plain"]);
    expect(shape('Write-Output "a $(Get-Date) b" next').at(-1)).toBe(
      'unsupported:"a $(Get-Date) b" next',
    );
  });

  it("keeps parameters, numbers with a type suffix, wildcards and home paths unbound", () => {
    expect(
      bindable("Get-ChildItem -Path:src -Filter *.ts -Depth 0x10 ~/notes 1kb -5 12 reports"),
    ).toEqual(["12", "reports"]);
  });

  it("models a variable assigned one string, named after the variable", () => {
    const source = "$region = 'emea'\n$ErrorActionPreference = 'Stop'\npython report.py $region";
    const tokens = tokenizeProgram("powershell", source);
    expect(shape(source)).toEqual([
      "word:$region",
      "operator:=",
      "string:'emea'*=emea",
      "operator:\n",
      "word:$ErrorActionPreference",
      "operator:=",
      "string:'Stop'=Stop",
      "operator:\n",
      "word:python",
      "word:report.py*",
      "word:$region",
    ]);
    expect(powershellValueName(tokens, 2)).toBe("region");
    expect(powershellValueName(tokenizeProgram("pwsh", "Invoke-X -OutFile a.txt"), 2)).toBe(
      "OutFile",
    );
  });

  it.each([
    ["a script block", "Get-ChildItem | ForEach-Object { $_.Name } | Out-File a.txt"],
    ["a group", "Write-Output (Get-Date) done.txt"],
    ["a here-string", "$x = @'\nhello\n'@\nWrite-Output x.txt"],
    ["splatting", "Copy-Item @params dest.txt"],
    ["stop-parsing", "icacls x.txt --% /grant Users:F"],
    ["a keyword statement", "if ($true) { Write-Output a.txt }"],
    ["exit", "Write-Output a.txt; exit $LASTEXITCODE"],
    ["an expression statement", "'text' | Out-File a.txt"],
    ["dot-sourcing", ". .\\env.ps1; Write-Output a.txt"],
    ["a type literal", "[IO.File]::ReadAllText('a.txt')"],
    ["input redirection", "sort < in.txt"],
    ["a background job", "Start-Server a.txt &"],
  ])("ends in one opaque token at %s", (_, source) => {
    const tokens = tokenizeProgram("pwsh", source);
    const last = tokens.at(-1)!;
    expect(last.kind).toBe("unsupported");
    expect(last.bindable).toBe(false);
    expect(last.end).toBe(source.length);
    expect(source.slice(last.start)).toBe(last.raw);
    for (const token of tokens) expect(source.slice(token.start, token.end)).toBe(token.raw);
  });

  it("reads && and || only in PowerShell 7", () => {
    const source = "dotnet build app.csproj && dotnet test app.csproj";
    expect(shape(source, "pwsh")).toEqual([
      "word:dotnet",
      "word:build*",
      "word:app.csproj*",
      "operator:&&",
      "word:dotnet",
      "word:test*",
      "word:app.csproj*",
    ]);
    expect(shape(source, "powershell").at(-1)).toBe("unsupported:&& dotnet test app.csproj");
  });

  it("calls a quoted command with & and keeps code strings unbound", () => {
    expect(shape("& 'C:\\Tools\\gen.exe' --out build\\a.txt")).toEqual([
      "operator:&",
      "string:'C:\\Tools\\gen.exe'=C:\\Tools\\gen.exe",
      "word:--out",
      "word:build\\a.txt*",
    ]);
    expect(bindable("python -c 'print(1)' data.csv")).toEqual(["data.csv"]);
    // pwsh's whole remaining command line is code: nothing after `-Command` is data.
    expect(bindable("pwsh -Command 'Get-Date' notes.txt")).toEqual([]);
  });

  it.each([
    ["Invoke-Expression", "Invoke-Expression 'Write-Output emea'"],
    ["the iex alias in another case", "IEX 'Write-Output emea'"],
    [
      "a module-qualified evaluator",
      "Microsoft.PowerShell.Utility\\Invoke-Expression 'x'; Write-Output emea",
    ],
    ["a variable a later iex runs", "$c = 'Write-Output emea'; iex $c"],
    ["Invoke-Command", "Invoke-Command -ComputerName host -FilePath run.ps1 emea"],
    ["Start-Process", "Start-Process powershell -ArgumentList emea"],
    ["Start-Job", "Start-Job -FilePath job.ps1 -ArgumentList emea"],
    ["Add-Type", "Add-Type -TypeDefinition 'public class A {}' emea"],
    ["an alias definition", "sal w iex; w 'emea'"],
    ["a function defined through its drive", "New-Item function:w -Value 'iex $args'; w emea"],
    ["a command named by a variable", "& $tool emea"],
    ["a batch file", ".\\report.cmd emea"],
    ["powershell -Command", "powershell.exe -Command Write-Output emea"],
    ["an abbreviated, quoted code flag", "pwsh '-com' Write-Output emea"],
    ["powershell's positional command", "powershell Write-Output emea"],
    ["pwsh by path", "& 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' -c Write-Output emea"],
    ["cmd /c", "cmd.exe /d /s /c echo emea"],
    ["cmd /k", "cmd /k echo emea"],
    ["wsl", "wsl ls emea"],
  ])("binds nothing in a program that calls %s", (_, source) => {
    for (const edition of EDITIONS) expect(bindable(source, edition), source).toEqual([]);
  });

  it("binds no assigned string a code runner's code could read, but keeps its other data", () => {
    expect(bindable("$r = 'emea'; python -c 'import os' $r data.csv")).toEqual(["data.csv"]);
    expect(bindable("$r = 'emea'; python report.py $r data.csv")).toEqual([
      "emea",
      "report.py",
      "data.csv",
    ]);
  });

  it("skips comments and line continuations, and keeps CRLF statements apart", () => {
    expect(
      shape("# prepare\r\nNew-Item -ItemType Directory `\r\n  -Force out <# quiet #> | Out-Null"),
    ).toEqual([
      "operator:\n",
      "word:New-Item",
      "word:-ItemType",
      "word:Directory*",
      "word:-Force",
      "word:out*",
      "operator:|",
      "word:Out-Null",
    ]);
  });

  it.each([
    ["a smart quote", "Write-Output \u2018a\u2019"],
    ["an en dash", "Get-ChildItem \u2013Path src"],
    ["a non-breaking space", "Write-Output\u00a0a"],
    ["a lone carriage return", "Write-Output a\rWrite-Output b"],
  ])("refuses %s", (_, source) => {
    for (const edition of EDITIONS)
      expect(() => tokenizeProgram(edition, source)).toThrow(ProgramTokenizationError);
  });
});

describe("rendering a bound PowerShell value", () => {
  const SOURCE = "python report.py --region emea --title 'Q1 report' > out/emea.txt";

  function render(values: Record<number, string>): string {
    const tokens = tokenizeProgram("powershell", SOURCE);
    return applyProgramTokenValues(
      SOURCE,
      tokens,
      new Map(Object.entries(values).map(([index, value]) => [Number(index), value])),
      "powershell",
    );
  }

  it("keeps a plain word bare and quotes anything else as data", () => {
    expect(render({ 3: "apac", 5: "Q2 report", 7: "out/apac.txt" })).toBe(
      "python report.py --region apac --title 'Q2 report' > out/apac.txt",
    );
    expect(render({ 3: "a;b $(rm -r x) `c'd" })).toBe(
      "python report.py --region 'a;b $(rm -r x) `c''d' --title 'Q1 report' > out/emea.txt",
    );
    // A value PowerShell would read as a parameter or a number stays a string.
    expect(render({ 3: "-Force" })).toContain("--region '-Force'");
    expect(render({ 3: "0x10" })).toContain("--region '0x10'");
    expect(render({ 3: "2025" })).toContain("--region 2025");
    expect(render({ 3: "2025-04" })).toContain("--region 2025-04");
    expect(render({ 3: "1kb" })).toContain("--region '1kb'");
  });

  it("round-trips: the rendered program reads back the bound value at the same token", () => {
    for (const value of ["apac", "it's", "a b", "C:\\Users\\me\\data.csv", "$HOME", "x`y", "1.5"]) {
      const rendered = render({ 3: value, 5: value });
      for (const edition of EDITIONS) {
        const tokens = tokenizeProgram(edition, rendered);
        expect(tokens[3]!.value, value).toBe(value);
        expect(tokens[5]!.value, value).toBe(value);
        expect(tokens).toHaveLength(tokenizeProgram(edition, SOURCE).length);
      }
    }
  });

  it.each([
    ["empty", ""],
    ["a double quote", 'say "hi"'],
    ["a cmd.exe command separator", "x&whoami"],
    ["a cmd.exe pipe", "x|whoami"],
    ["a cmd.exe variable", "%USERPROFILE%"],
    ["a delayed expansion", "!PATH!"],
    ["a line break", "a\nb"],
    ["a trailing backslash after a blank", "C:\\My Data\\"],
    ["a control character", "a\u0001b"],
  ])("refuses a value that is %s", (_, value) => {
    expect(() => render({ 3: value })).toThrow();
  });

  it("binds a program template in its own grammar", () => {
    const template = bindProgramToken({ type: "literal", value: SOURCE }, "pwsh", 3, {
      type: "input",
      name: "region",
    });
    expect(template).toMatchObject({ type: "program", language: "pwsh" });
    expect(() =>
      bindProgramToken({ type: "literal", value: SOURCE }, "pwsh", 0, {
        type: "input",
        name: "x",
      }),
    ).toThrow(/not safely bindable/);
  });
});

describe("shell dialects", () => {
  it("proves a dialect only from the executable a harness recorded running", () => {
    expect(
      windowsShellInvocation("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
        "-Command",
        "Get-Date",
      ]),
    ).toEqual({ dialect: "powershell", program: "Get-Date" });
    expect(
      windowsShellInvocation("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
        "-NoProfile",
        "-Command",
        "Get-Date",
      ]),
    ).toEqual({ dialect: "pwsh", program: "Get-Date" });
    expect(windowsShellInvocation("cmd.exe", ["/d", "/s", "/c", "dir"])).toEqual({
      dialect: "cmd",
      program: "dir",
    });
    for (const [executable, args] of [
      ["powershell.exe", ["-File", "x.ps1"]],
      ["powershell.exe", ["-ExecutionPolicy", "Bypass", "-Command", "x"]],
      ["pwsh", ["-EncodedCommand", "eAA="]],
      ["cmd.exe", ["/k", "dir"]],
      ["/bin/bash", ["-lc", "ls"]],
      ["powershell-helper.exe", ["-Command", "x"]],
    ] as const)
      expect(windowsShellInvocation(executable, args)).toBeUndefined();
    expect(shellDialectOfExecutable("/usr/bin/pwsh")).toBe("pwsh");
    expect(shellDialectOfExecutable("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  });

  it("reads each dialect in its own grammar, and cmd or an unproven dialect in none", () => {
    expect(recordedProgramLanguage({ kind: "shell" })).toBe("shell");
    expect(recordedProgramLanguage({ kind: "shell", dialect: "bash" })).toBe("shell");
    expect(recordedProgramLanguage({ kind: "shell", dialect: "powershell" })).toBe("powershell");
    expect(recordedProgramLanguage({ kind: "shell", dialect: "pwsh" })).toBe("pwsh");
    expect(recordedProgramLanguage({ kind: "shell", dialect: "cmd" })).toBeUndefined();
    expect(recordedProgramLanguage({ kind: "shell", unprovenDialect: true })).toBeUndefined();
    expect(programNotLearnableReason({ kind: "shell", dialect: "cmd" })).toBe(
      CMD_NOT_LEARNABLE_REASON,
    );
    expect(programNotLearnableReason({ kind: "shell", unprovenDialect: true })).toBe(
      UNPROVEN_SHELL_DIALECT_REASON,
    );
    expect(programNotLearnableReason({ kind: "shell", dialect: "pwsh" })).toBeUndefined();
  });

  it("keeps PowerShell, PowerShell 7 and POSIX apart and never splits a PowerShell chain", () => {
    const dialects = [
      recordedShellDialect("Bash", {}),
      recordedShellDialect("command_exec", {}, { dialect: "powershell" }),
      recordedShellDialect("command_exec", {}, { dialect: "pwsh" }),
      recordedShellDialect("command_exec", {}, { dialect: "cmd" }),
    ];
    expect(new Set(dialects).size).toBe(4);
    expect(recordedShellDialect("Bash", {}, { unprovenDialect: true })).toBeUndefined();
    expect(recordedPosixShell("command_exec", {}, { dialect: "pwsh" })).toBeUndefined();
    expect(recordedPosixShell("command_exec", {}, { dialect: "bash" })).toBe("bash");
    for (const shell of ["powershell", "pwsh", "cmd"])
      expect(splitShellAndChain(shell, "make && ls")).toBeUndefined();
  });

  it("finds Resin and harness MCP listings in PowerShell and cmd programs", () => {
    expect(isHarnessIntrospectionProgram("resin.exe status --json", "powershell")).toBe(true);
    expect(isHarnessIntrospectionProgram("& codex.exe mcp list", "pwsh")).toBe(true);
    expect(isHarnessIntrospectionProgram("pwsh -Command 'resin status'", "pwsh")).toBe(true);
    expect(isHarnessIntrospectionProgram("dir && resin status", "cmd")).toBe(true);
    expect(isHarnessIntrospectionProgram("Get-ChildItem src", "powershell")).toBe(false);
    expect(isHarnessIntrospectionProgram("dir src", "cmd")).toBe(false);
  });
});

describe("recorded workflows in a shell dialect", () => {
  const SOURCE = "python report.py --region emea";
  function workflow(
    program: Record<string, unknown>,
    language: string,
    candidates: RecordedWorkflow["candidates"] = [],
  ): unknown {
    return {
      schemaVersion: 1,
      workflowId: "wf",
      inputs: [],
      steps: [
        {
          id: "s0",
          callId: "c0",
          callable: {
            runtime: "resin-process",
            name: "command_exec",
            program: { kind: "shell", source: SOURCE, argument: "cmd", ...program },
          },
          arguments: [
            {
              name: "cmd",
              source: {
                kind: "template",
                template: {
                  type: "program",
                  language,
                  source: { type: "literal", value: SOURCE },
                  holes: [],
                },
              },
            },
          ],
          dependsOn: [],
          failurePolicy: { onError: "abort", policy: "default" },
          observed: { outcome: "succeeded" },
        },
      ],
      candidates,
    };
  }

  it("accepts a template in its program's dialect grammar and rejects any other", () => {
    expect(validateRecordedWorkflow(workflow({ dialect: "powershell" }, "powershell"))).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateRecordedWorkflow(workflow({ dialect: "powershell" }, "shell")).errors.join("\n"),
    ).toMatch(/another shell dialect/);
    expect(
      validateRecordedWorkflow(workflow({ dialect: "pwsh" }, "powershell")).errors.join("\n"),
    ).toMatch(/another shell dialect/);
    expect(
      validateRecordedWorkflow(workflow({ dialect: "zsh" }, "shell")).errors.join("\n"),
    ).toMatch(/invalid recorded shell dialect/);
  });

  it("reports a cmd program as not learnable", () => {
    const candidate = {
      stepId: "s0",
      argument: "cmd",
      path: ["tokens", 3],
      proposed: { kind: "input" as const, name: "region", type: "string" as const },
      reason: "native-data-argument" as const,
      missing: "a demonstration",
    };
    const errors = validateRecordedWorkflow(
      workflow({ dialect: "cmd" }, "shell", [candidate]),
    ).errors;
    expect(errors).toContain(`step s0 argument cmd: ${CMD_NOT_LEARNABLE_REASON}`);
    expect(errors).toContain(`candidate s0.cmd: ${CMD_NOT_LEARNABLE_REASON}`);
  });
});
