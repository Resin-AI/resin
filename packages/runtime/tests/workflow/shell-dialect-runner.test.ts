/**
 * A recorded shell program runs in the shell its recording proved: Windows PowerShell 5.1, PowerShell
 * 7, or a POSIX shell (Git Bash on Windows) — never cmd.exe, never another dialect, and a cmd.exe or
 * unproven program not at all.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CMD_NOT_LEARNABLE_REASON, UNPROVEN_SHELL_DIALECT_REASON } from "@resin/contracts";
import { serviceHostExecutablePath } from "@resin/windows-security";
import { describe, expect, it } from "vitest";
import { runRecordedProgram } from "../../src/workflow/program-runner.js";
import {
  POWERSHELL_REPLAY_FLAGS,
  type ShellInvocationContext,
  powershellReplaySource,
  resolveGitBash,
  resolvePwsh,
  resolveWindowsPowerShell,
  shellProgramInvocation,
  windowsCommandLineLength,
} from "../../src/workflow/shell-invocation.js";

const WINDOWS_ENV = {
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  Path: "C:\\Windows\\System32;C:\\Tools",
};

/** Git for Windows' MSYS runtime, which marks an installation's bash as Git Bash. */
const msys = (root: string) => `${root}\\usr\\bin\\msys-2.0.dll`;

function windows(
  existing: readonly string[],
  env: NodeJS.ProcessEnv = WINDOWS_ENV,
  links: Readonly<Record<string, string>> = {},
) {
  const files = new Set(existing.map((file) => file.toLowerCase()));
  return {
    platform: "win32",
    env,
    executableExists: (candidate: string) => files.has(candidate.toLowerCase()),
    realpath: (candidate: string) => links[candidate] ?? candidate,
  } satisfies ShellInvocationContext;
}

function linux(existing: readonly string[], env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }) {
  const files = new Set(existing);
  return {
    platform: "linux",
    env,
    executableExists: (candidate: string) => files.has(candidate),
  } satisfies ShellInvocationContext;
}

const POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const PWSH_EXE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const GIT_MSYS = msys("C:\\Program Files\\Git");
const MSYS_BASH = "C:\\Program Files\\Git\\usr\\bin\\bash.exe";

function decoded(args: readonly string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1]!;
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("the shell a recorded program runs in", () => {
  const SOURCE = "Get-Content -Path data.csv | Select-Object -First 2";

  it("runs Windows PowerShell 5.1 programs in powershell.exe, encoded and without PSModulePath", () => {
    const invocation = shellProgramInvocation(
      { dialect: "powershell" },
      SOURCE,
      windows([POWERSHELL_EXE, PWSH_EXE]),
    );
    expect(invocation.command).toBe(POWERSHELL_EXE);
    expect(invocation.args.slice(0, -1)).toEqual([...POWERSHELL_REPLAY_FLAGS, "-EncodedCommand"]);
    expect(POWERSHELL_REPLAY_FLAGS).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
    ]);
    expect(decoded(invocation.args)).toBe(powershellReplaySource(SOURCE));
    expect(powershellReplaySource(SOURCE).split("\n")[1]).toBe(SOURCE);
    expect(powershellReplaySource(SOURCE)).toMatch(/\$LASTEXITCODE/);
    expect(invocation.unsetEnv).toEqual(["PSModulePath"]);
  });

  it("runs PowerShell 7 programs in pwsh, on Windows or elsewhere, never in 5.1", () => {
    expect(
      shellProgramInvocation({ dialect: "pwsh" }, SOURCE, windows([POWERSHELL_EXE, PWSH_EXE])),
    ).toMatchObject({
      command: PWSH_EXE,
      args: [...POWERSHELL_REPLAY_FLAGS, "-EncodedCommand", expect.any(String)],
    });
    const onLinux = shellProgramInvocation({ dialect: "pwsh" }, SOURCE, linux(["/usr/bin/pwsh"]));
    expect(onLinux.command).toBe("/usr/bin/pwsh");
    expect(onLinux.args.slice(0, -1)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(() =>
      shellProgramInvocation({ dialect: "pwsh" }, SOURCE, windows([POWERSHELL_EXE])),
    ).toThrow(
      /PowerShell 7 \(pwsh\), which was not found.*never replayed in Windows PowerShell 5\.1/,
    );
  });

  it("refuses Windows PowerShell 5.1 off Windows and when powershell.exe is missing", () => {
    expect(() =>
      shellProgramInvocation({ dialect: "powershell" }, SOURCE, linux(["/usr/bin/pwsh"])),
    ).toThrow(/runs only on Windows/);
    expect(() =>
      shellProgramInvocation({ dialect: "powershell" }, SOURCE, windows([PWSH_EXE])),
    ).toThrow(/powershell\.exe was not found/);
  });

  it("refuses a PowerShell program too long for one command line", () => {
    expect(() =>
      shellProgramInvocation(
        { dialect: "powershell" },
        `Write-Output '${"x".repeat(12_000)}'`,
        windows([POWERSHELL_EXE]),
      ),
    ).toThrow(/too long/);
  });

  it("never replays cmd.exe or an unproven dialect", () => {
    for (const context of [windows([POWERSHELL_EXE, GIT_BASH, GIT_MSYS]), linux(["/bin/bash"])]) {
      expect(() => shellProgramInvocation({ dialect: "cmd" }, "dir", context)).toThrow(
        CMD_NOT_LEARNABLE_REASON,
      );
      expect(() => shellProgramInvocation({ unprovenDialect: true }, "dir", context)).toThrow(
        UNPROVEN_SHELL_DIALECT_REASON,
      );
    }
  });

  it("runs POSIX programs in Git Bash on Windows, never cmd.exe or WSL's bash", () => {
    // Git's MSYS bash itself, with the environment Git's launcher would give it, so that every
    // process a program starts descends from the replay's own child.
    const installed = [GIT_BASH, GIT_MSYS, MSYS_BASH, "C:\\Program Files\\Git\\mingw64\\bin"];
    for (const dialect of [undefined, "bash", "sh", "dash", "sh-or-zsh"] as const) {
      expect(
        shellProgramInvocation(
          dialect === undefined ? {} : { dialect },
          "make && ls",
          windows([...installed, "C:\\Windows\\System32\\bash.exe"]),
        ),
      ).toEqual({
        command: MSYS_BASH,
        args: ["-c", "make && ls"],
        setEnv: {
          MSYSTEM: "MINGW64",
          PATH: `C:\\Program Files\\Git\\mingw64\\bin;C:\\Program Files\\Git\\usr\\bin;${WINDOWS_ENV.Path}`,
        },
      });
    }
    expect(
      shellProgramInvocation({ dialect: "bash" }, "ls", {
        ...windows(installed),
        bashLogin: true,
      }),
    ).toMatchObject({
      command: MSYS_BASH,
      args: ["-lc", expect.stringMatching(/^exec 2>&1; .*cygpath -u -p .*; ls$/)],
    });
    // WSL's launcher on PATH is never taken for Git Bash.
    expect(() =>
      shellProgramInvocation(
        { dialect: "bash" },
        "ls",
        windows(["C:\\Windows\\System32\\bash.exe"]),
      ),
    ).toThrow(/Git for Windows' bash\.exe was not found.*never replayed in cmd\.exe/);
  });

  it("finds Git Bash from the override, the install locations, or git on PATH", () => {
    const override = "D:\\PortableGit\\bin\\bash.exe";
    expect(
      resolveGitBash(
        windows([override, msys("D:\\PortableGit"), GIT_BASH, GIT_MSYS], {
          ...WINDOWS_ENV,
          CLAUDE_CODE_GIT_BASH_PATH: override,
        }),
      ),
    ).toBe(override);
    const perUser = "C:\\Users\\dev\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(
      resolveGitBash(windows([perUser, msys("C:\\Users\\dev\\AppData\\Local\\Programs\\Git")])),
    ).toBe(perUser);
    const scoop = { ...WINDOWS_ENV, Path: "C:\\scoop\\apps\\git\\current\\cmd" };
    expect(
      resolveGitBash(
        windows(
          [
            "C:\\scoop\\apps\\git\\current\\cmd\\git.exe",
            "C:\\scoop\\apps\\git\\current\\bin\\bash.exe",
            msys("C:\\scoop\\apps\\git\\current"),
          ],
          scoop,
        ),
      ),
    ).toBe("C:\\scoop\\apps\\git\\current\\bin\\bash.exe");
    expect(resolveWindowsPowerShell(windows([POWERSHELL_EXE]))).toBe(POWERSHELL_EXE);
    expect(resolvePwsh(windows([PWSH_EXE]))).toBe(PWSH_EXE);
  });

  it.each([
    ["WSL's launcher", "C:\\Windows\\System32\\bash.exe", {}],
    ["WSL's launcher by another spelling", "c:\\WINDOWS\\sysnative\\..\\System32\\BASH.EXE", {}],
    [
      "a link that resolves to WSL's launcher",
      "D:\\links\\bin\\bash.exe",
      { "D:\\links\\bin\\bash.exe": "C:\\Windows\\System32\\bash.exe" },
    ],
    [
      "an app-execution alias",
      "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe",
      {},
    ],
    ["a bash that is not Git's", "D:\\tools\\bin\\bash.exe", {}],
    ["another program", "D:\\PortableGit\\bin\\zsh.exe", {}],
  ])(
    "refuses a CLAUDE_CODE_GIT_BASH_PATH override naming %s, never falling back",
    (_, override, links) => {
      const context = windows(
        [override, msys("D:\\PortableGit"), msys("D:\\links"), GIT_BASH, GIT_MSYS],
        { ...WINDOWS_ENV, CLAUDE_CODE_GIT_BASH_PATH: override },
        links,
      );
      expect(resolveGitBash(context)).toBeUndefined();
      expect(() => shellProgramInvocation({ dialect: "bash" }, "ls", context)).toThrow(
        /Git for Windows' bash\.exe was not found/,
      );
    },
  );

  it("refuses a POSIX program too long for one Windows command line, measured as Node quotes it", () => {
    const context = windows([GIT_BASH, GIT_MSYS]);
    expect(() =>
      shellProgramInvocation({ dialect: "bash" }, `echo '${"x".repeat(32_000)}'`, context),
    ).toThrow(/too long to pass to its shell on one Windows command line/);
    expect(
      shellProgramInvocation({ dialect: "bash" }, `echo '${"x".repeat(20_000)}'`, context).command,
    ).toBe(GIT_BASH);
    expect(windowsCommandLineLength("a.exe", ["plain", "two words", 'say "hi"', "dir\\", ""])).toBe(
      'a.exe plain "two words" "say \\"hi\\"" dir\\ ""'.length,
    );
    expect(windowsCommandLineLength("a", ["x y\\"])).toBe('a "x y\\\\"'.length);
  });

  it("runs POSIX programs in /bin/sh on POSIX hosts, and proven bash programs in bash", () => {
    const context = linux(["/bin/bash", "/bin/sh"]);
    expect(shellProgramInvocation({}, "ls", context)).toEqual({
      command: "/bin/sh",
      args: ["-c", "ls"],
    });
    expect(shellProgramInvocation({ dialect: "sh-or-zsh" }, "ls", context)).toEqual({
      command: "/bin/sh",
      args: ["-c", "ls"],
    });
    expect(shellProgramInvocation({ dialect: "bash" }, "ls", context)).toEqual({
      command: "/bin/bash",
      args: ["-c", "ls"],
    });
    expect(
      shellProgramInvocation({ dialect: "bash" }, "ls", {
        ...context,
        bashLogin: true,
        bashLoginPrelude: "exec 2>&1; ",
      }),
    ).toEqual({ command: "/bin/bash", args: ["-lc", "exec 2>&1; ls"] });
    expect(() => shellProgramInvocation({ dialect: "bash" }, "ls", linux(["/bin/sh"]))).toThrow(
      /bash, which was not found/,
    );
  });
});

const ON_WINDOWS = process.platform === "win32";
const HAS_PWSH = resolvePwsh({ platform: process.platform, env: process.env }) !== undefined;

/**
 * Whether a process whose command line carries `marker` is still running a few seconds on. The
 * pattern is spelled so that it never matches the checking process's own command line.
 */
function stillRunning(marker: string): boolean {
  // The waiting happens in the child shell, which gives the kill time to land.
  const check = ON_WINDOWS
    ? spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `$m = '${marker.slice(0, 1)}' + '${marker.slice(1)}'; for ($i = 0; $i -lt 40; $i++) { if (-not (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*$m*" })) { exit 0 }; Start-Sleep -Milliseconds 250 }; exit 1`,
        ],
        { windowsHide: true },
      )
    : spawnSync("sh", [
        "-c",
        `for i in $(seq 40); do pgrep -f '[${marker.slice(0, 1)}]${marker.slice(1)}' >/dev/null || exit 0; sleep 0.25; done; exit 1`,
      ]);
  return check.status !== 0;
}

/** Whether Windows replays run inside Resin's kill-on-close job host (native prebuilds built). */
const WINDOWS_JOB_HOST =
  ON_WINDOWS &&
  (() => {
    try {
      serviceHostExecutablePath();
      return true;
    } catch {
      return false;
    }
  })();

describe("a program whose shell exits while a background child holds its output", () => {
  const orphanSource = (marker: string, tail: string) => {
    const node = process.execPath.replaceAll("\\", "/");
    return `"${node}" -e "setTimeout(() => {}, 600000)" ${marker} & ${tail}`;
  };
  const dialect = ON_WINDOWS ? "bash" : "sh";
  const hasShell = () =>
    !ON_WINDOWS || resolveGitBash({ platform: "win32", env: process.env }) !== undefined;

  it.skipIf(WINDOWS_JOB_HOST)("ends at its time budget and stops the child", async () => {
    if (!hasShell()) return;
    const marker = `resin-orphan-${process.pid}-${Date.now()}`;
    const started = process.hrtime.bigint();
    await expect(
      runRecordedProgram(
        { kind: "shell", dialect, source: orphanSource(marker, "echo started") },
        { timeoutMs: 1_500 },
      ),
    ).rejects.toThrow(/1500ms time budget/);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(20_000);
    expect(stillRunning(marker)).toBe(false);
  });

  // Windows replays run in a kill-on-close job: what a program leaves running ends with it.
  it.runIf(WINDOWS_JOB_HOST)(
    "ends with its shell on Windows and stops what it left running",
    async () => {
      if (!hasShell()) return;
      const marker = `resin-orphan-${process.pid}-${Date.now()}`;
      const run = await runRecordedProgram(
        { kind: "shell", dialect, source: orphanSource(marker, "echo started") },
        { timeoutMs: 60_000 },
      );
      expect(run).toMatchObject({ exitCode: 0 });
      expect(run.stdout.trim()).toBe("started");
      expect(stillRunning(marker)).toBe(false);
    },
  );

  it.runIf(WINDOWS_JOB_HOST)("stops the whole tree at its time budget on Windows", async () => {
    if (!hasShell()) return;
    const marker = `resin-orphan-${process.pid}-${Date.now()}`;
    const started = process.hrtime.bigint();
    await expect(
      runRecordedProgram(
        { kind: "shell", dialect, source: orphanSource(marker, "echo started; sleep 60") },
        { timeoutMs: 1_500 },
      ),
    ).rejects.toThrow(/1500ms time budget/);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(20_000);
    expect(stillRunning(marker)).toBe(false);
  });
});

describe.runIf(!ON_WINDOWS)("running a POSIX program on this host", () => {
  it("runs a proven bash program in bash", async () => {
    const run = await runRecordedProgram({
      kind: "shell",
      dialect: "bash",
      source: "[[ 1 == 1 ]] && echo ok",
    });
    expect(run).toMatchObject({ exitCode: 0, stdout: "ok\n" });
  });
});

/**
 * A freshly provisioned image without precompiled .NET Framework assemblies (e.g. GitHub's
 * windows-11-arm) spends ~20 s starting each powershell.exe; some tests here start several.
 */
describe.runIf(ON_WINDOWS)(
  "running a Windows PowerShell 5.1 program for real",
  { timeout: 180_000 },
  () => {
    const ps = (source: string, env?: Record<string, string>) =>
      runRecordedProgram({ kind: "shell", dialect: "powershell", source }, env ? { env } : {});

    it("prints UTF-8 and exits 0", async () => {
      const run = await ps("$name = 'wörld ✓'\nWrite-Output \"hello $name\"");
      expect(run.exitCode).toBe(0);
      expect(run.stdout.trim()).toBe("hello wörld ✓");
    });

    it("maps a failed last native command, a throw and exit to non-zero exit codes", async () => {
      expect((await ps("Write-Output a\ncmd /c exit 3")).exitCode).toBe(3);
      expect((await ps("throw 'broken'")).exitCode).toBe(1);
      expect((await ps("Write-Output a; exit 7")).exitCode).toBe(7);
      expect((await ps("Get-Item -Path does-not-exist.txt")).exitCode).toBe(1);
      // A native failure earlier in the program does not fail a program whose last statement succeeded.
      expect((await ps("cmd /c exit 2\nWrite-Output done")).exitCode).toBe(0);
    });

    it("does not inherit PowerShell 7's module path", async () => {
      const run = await ps("Write-Output $env:PSModulePath", {
        PSModulePath: "C:\\resin-not-a-module-path",
      });
      expect(run.stdout).not.toContain("resin-not-a-module-path");
      expect(
        (
          await ps("(Get-FileHash -InputStream ([IO.MemoryStream]::new())).Algorithm")
        ).stdout.trim(),
      ).toBe("SHA256");
    });

    it("runs a POSIX program in Git Bash, not cmd.exe", async () => {
      const bash = resolveGitBash({ platform: "win32", env: process.env });
      if (bash === undefined) return;
      const run = await runRecordedProgram({
        kind: "shell",
        dialect: "bash",
        source: "echo $((1 + 2)) \"a b\" 'c'",
      });
      expect(run).toMatchObject({ exitCode: 0 });
      expect(run.stdout.trim()).toBe("3 a b c");
      expect(path.win32.basename(bash).toLowerCase()).toBe("bash.exe");
    });
  },
);

describe.runIf(HAS_PWSH)("running a PowerShell 7 program for real", () => {
  it("runs && chains and maps a failure", async () => {
    const run = await runRecordedProgram({
      kind: "shell",
      dialect: "pwsh",
      source: "Write-Output first && Write-Output second",
    });
    expect(run.stdout.split(/\r?\n/).filter(Boolean)).toEqual(["first", "second"]);
    const failed = await runRecordedProgram({ kind: "shell", dialect: "pwsh", source: "exit 4" });
    expect(failed.exitCode).toBe(4);
  });
});
