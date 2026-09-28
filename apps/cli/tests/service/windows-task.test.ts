import path from "node:path";
import { InMemoryConfigFsBridge } from "@resin/harness-contracts";
import { describe, expect, it } from "vitest";
import {
  generateWindowsTaskXml,
  validateServiceDefinition,
} from "../../src/platform/service-generator.js";
import {
  type ServiceCommandResult,
  type ServiceCommandRunner,
  WindowsTaskUserServiceManager,
  createUserServiceManager,
  isStaleSupervisorUnitContent,
} from "../../src/service/manager.js";
import {
  WINDOWS_TASK_DEFAULT_NAME,
  type WindowsServiceHostFiles,
  buildWindowsTaskXml,
  escapeTaskXml,
  parseWhoamiSid,
  parseWindowsTaskStatus,
  quoteWindowsArgument,
  resolveServiceHostSourcePath,
  resolveWindowsTaskName,
  serviceStopRequestPath,
  splitWindowsTaskName,
  windowsTaskFolderCleanupScript,
  windowsTaskStatusScript,
} from "../../src/service/windows-task.js";

const SID = "S-1-5-21-2229100518-3101234002-661721488-1002";
const SYSTEM_ENV = { SystemRoot: "C:\\Windows" };
const SCHTASKS = "C:\\Windows\\System32\\schtasks.exe";
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const homeDir = path.join(path.sep, "users", "dev");
const resinHome = path.join(homeDir, ".resin");

const RUNNING = JSON.stringify({
  installed: true,
  state: 4,
  enabled: true,
  lastTaskResult: 267009,
  pid: 4242,
});
const READY = JSON.stringify({
  installed: true,
  state: 3,
  enabled: true,
  lastTaskResult: 0,
  pid: null,
});
const MISSING = JSON.stringify({ installed: false });

interface RecordedCall {
  cmd: string;
  args: string[];
  script?: string;
}

function decodeScript(args: readonly string[]): string {
  const encoded = args[args.indexOf("-EncodedCommand") + 1] ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

/** Scripted runner: status queries consume `statuses` (the last one repeats). */
function scriptedRunner(
  statuses: string[],
  overrides: Partial<Record<string, ServiceCommandResult>> = {},
): ServiceCommandRunner & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async run(cmd, args) {
      if (cmd === POWERSHELL) {
        const script = decodeScript(args);
        calls.push({ cmd, args, script });
        if (script.includes("GetInstances")) {
          const stdout =
            statuses.length > 1 ? (statuses.shift() ?? MISSING) : (statuses[0] ?? MISSING);
          return { stdout, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      calls.push({ cmd, args });
      return overrides[args[0] ?? ""] ?? { stdout: "SUCCESS", stderr: "", exitCode: 0 };
    },
  };
}

function recordingHostFiles(leftovers: string[] = []): WindowsServiceHostFiles & {
  installed: Array<[string, string]>;
  removed: string[];
} {
  const installed: Array<[string, string]> = [];
  const removed: string[] = [];
  return {
    installed,
    removed,
    async installHost(source, target) {
      installed.push([source, target]);
    },
    async removeHost(target) {
      removed.push(target);
      return leftovers;
    },
  };
}

function createManager(
  runner: ServiceCommandRunner,
  fsBridge = new InMemoryConfigFsBridge(),
  hostFiles = recordingHostFiles(),
  daemonPath?: string,
): WindowsTaskUserServiceManager {
  return new WindowsTaskUserServiceManager({
    homeDir,
    resinHome,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    supervisorEntryPath: "C:\\Users\\dev\\.resin\\current\\apps\\cli\\dist\\index.js",
    daemonPath,
    fsBridge,
    runner,
    env: { RESIN_LOG_LEVEL: "info", PATH: "C:\\frozen" },
    windowsTask: {
      userSid: SID,
      serviceHostSourcePath: "C:\\release\\resin-service-host.exe",
      hostFiles,
      systemEnv: SYSTEM_ENV,
      wait: async () => undefined,
      stopTimeoutMs: 1_000,
      pollIntervalMs: 250,
    },
  });
}

/** Reverses quoteWindowsArgument with the MSVC/CommandLineToArgvW rules. */
function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let hasArgument = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const character = commandLine[index];
    if (character === "\\") {
      let backslashes = 0;
      while (commandLine[index] === "\\") {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        current += "\\".repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          current += '"';
        } else {
          inQuotes = !inQuotes;
        }
        hasArgument = true;
      } else {
        current += "\\".repeat(backslashes);
        index -= 1;
        hasArgument = true;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = !inQuotes;
      hasArgument = true;
      continue;
    }
    if ((character === " " || character === "\t") && !inQuotes) {
      if (hasArgument) args.push(current);
      current = "";
      hasArgument = false;
      continue;
    }
    current += character;
    hasArgument = true;
  }
  if (hasArgument) args.push(current);
  return args;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9A-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function actionArguments(xml: string): string[] {
  const match = xml.match(/<Arguments>([^<]*)<\/Arguments>/);
  return parseWindowsCommandLine(unescapeXml(match?.[1] ?? ""));
}

describe("Windows command-line quoting and XML escaping", () => {
  it.each([
    ["plain", "plain"],
    ["", '""'],
    ["C:\\Program Files\\nodejs\\node.exe", '"C:\\Program Files\\nodejs\\node.exe"'],
    ["C:\\dir with space\\", '"C:\\dir with space\\\\"'],
    ['say "hi"', '"say \\"hi\\""'],
    ["back\\\\slash", "back\\\\slash"],
  ])("quotes %j as %j and round-trips", (argument, expected) => {
    expect(quoteWindowsArgument(argument)).toBe(expected);
    expect(parseWindowsCommandLine(quoteWindowsArgument(argument))).toEqual([argument]);
  });

  it("escapes markup and non-ASCII into ASCII character references", () => {
    expect(escapeTaskXml(`Zoë & <tag> "q" 'a' 日本`)).toBe(
      "Zo&#xEB; &amp; &lt;tag&gt; &quot;q&quot; &apos;a&apos; &#x65E5;&#x672C;",
    );
    expect(() => escapeTaskXml("line\nbreak")).toThrow(/control characters/);
  });
});

describe("Windows scheduled task definition", () => {
  it("builds a per-user logon task with least privilege and no time limit", () => {
    const xml = buildWindowsTaskXml({
      userSid: SID,
      hostPath: "C:\\Users\\Zoë\\.resin\\services\\resin-service-host.exe",
      hostArguments: ["--", "C:\\Program Files\\nodejs\\node.exe", "x.js"],
      workingDirectory: "C:\\Users\\Zoë\\.resin",
    });

    expect(xml.startsWith("<Task ")).toBe(true);
    expect(xml).not.toContain("<?xml");
    expect(/[^\x09\x0a\x0d\x20-\x7e]/.test(xml)).toBe(false);
    expect(xml).toContain(
      `<LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${SID}</UserId>`,
    );
    expect(xml).toContain(`<UserId>${SID}</UserId>\n      <LogonType>InteractiveToken</LogonType>`);
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>999</Count>");
    expect(xml).toContain(
      "<Command>C:\\Users\\Zo&#xEB;\\.resin\\services\\resin-service-host.exe</Command>",
    );
    expect(actionArguments(xml)).toEqual(["--", "C:\\Program Files\\nodejs\\node.exe", "x.js"]);
    expect(validateServiceDefinition("windows-task", xml)).toEqual({ valid: true, errors: [] });
  });

  it("generates a valid task from the standalone service generator", () => {
    const xml = generateWindowsTaskXml({
      userSid: SID,
      resinHome: "C:\\Users\\dev\\.resin",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(validateServiceDefinition("windows-task", xml)).toEqual({ valid: true, errors: [] });
    expect(actionArguments(xml).slice(-2)).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\dev\\.resin\\bin\\resin-daemon.mjs",
    ]);
    expect(validateServiceDefinition("windows-task", xml.replace("PT0S", "PT72H")).valid).toBe(
      false,
    );
  });

  it("rejects a malformed SID", () => {
    expect(() =>
      buildWindowsTaskXml({
        userSid: "Everyone",
        hostPath: "host.exe",
        hostArguments: [],
        workingDirectory: "C:\\",
      }),
    ).toThrow(/SID/);
  });

  it("runs the host, then the supervisor under Node with the .mjs daemon launcher", () => {
    const manager = createManager(scriptedRunner([MISSING]));
    const xml = manager.getUnitDefinition();
    const args = actionArguments(xml);
    const separator = args.indexOf("--");

    expect(xml).toContain(
      `<Command>${path.join(resinHome, "services", "resin-service-host.exe")}</Command>`,
    );
    expect(args.slice(0, separator)).toEqual([
      "--stdout",
      path.win32.join(resinHome, "logs", "daemon.stdout.log"),
      "--stderr",
      path.win32.join(resinHome, "logs", "daemon.stderr.log"),
      "--cwd",
      resinHome,
      "--restart-delay-seconds",
      "60",
      "--restart-limit",
      "999",
      "--path-prepend",
      "C:\\Program Files\\nodejs",
      "--env",
      "RESIN_LOG_LEVEL=info",
      "--env",
      `RESIN_HOME=${resinHome}`,
      "--env",
      "NODE_ENV=production",
    ]);
    expect(args.slice(separator + 1)).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Users\\dev\\.resin\\current\\apps\\cli\\dist\\index.js",
      "__service-supervisor",
      "--resin-home",
      resinHome,
      "--",
      "C:\\Program Files\\nodejs\\node.exe",
      path.join(resinHome, "bin", "resin-daemon.mjs"),
      "--foreground",
    ]);
  });

  it("refuses batch launchers so the daemon never runs through cmd.exe", () => {
    const manager = createManager(
      scriptedRunner([MISSING]),
      new InMemoryConfigFsBridge(),
      recordingHostFiles(),
      "C:\\Users\\dev\\.resin\\bin\\resin-daemon.cmd",
    );
    expect(() => manager.getUnitDefinition()).toThrow(/batch launcher/);
  });

  it("treats the task action as the service identity when checking staleness", () => {
    const manager = createManager(scriptedRunner([MISSING]));
    const current = manager.getUnitDefinition();
    expect(isStaleSupervisorUnitContent(current, current)).toBe(false);
    expect(
      isStaleSupervisorUnitContent(
        current.replace(`${SID}</UserId>`, "S-1-5-18</UserId>"),
        current,
      ),
    ).toBe(false);
    expect(
      isStaleSupervisorUnitContent(
        current.replace("RESIN_LOG_LEVEL=info", "RESIN_LOG_LEVEL=debug"),
        current,
      ),
    ).toBe(true);
    expect(
      isStaleSupervisorUnitContent(
        current.replace(
          "C:\\Users\\dev\\.resin\\current\\apps",
          "C:\\Users\\dev\\.resin\\versions\\v1.0.0\\apps",
        ),
        current,
      ),
    ).toBe(true);
  });
});

describe("Windows scheduled task status", () => {
  it("parses numeric task states and ignores localized noise before the JSON line", () => {
    expect(parseWindowsTaskStatus(`\uFEFFwarning text\r\n${RUNNING}\r\n`)).toEqual({
      installed: true,
      state: "running",
      running: true,
      enabled: true,
      lastTaskResult: 267009,
      pid: 4242,
    });
    expect(parseWindowsTaskStatus(READY)).toEqual({
      installed: true,
      state: "ready",
      running: false,
      enabled: true,
      lastTaskResult: 0,
    });
    expect(
      parseWindowsTaskStatus(JSON.stringify({ installed: true, state: 1, enabled: false })),
    ).toMatchObject({ state: "disabled", running: false, enabled: false });
    expect(parseWindowsTaskStatus(MISSING)).toEqual({
      installed: false,
      state: "not_installed",
      running: false,
      enabled: false,
    });
    expect(() => parseWindowsTaskStatus("Wird ausgeführt")).toThrow(/Unrecognized/);
    expect(() => parseWindowsTaskStatus(JSON.stringify({ installed: true, state: 9 }))).toThrow();
  });

  it("queries the task through the Task Scheduler COM API, not localized schtasks text", () => {
    const script = windowsTaskStatusScript(WINDOWS_TASK_DEFAULT_NAME);
    expect(script).toContain("New-Object -ComObject Schedule.Service");
    expect(script).toContain("$service.GetFolder('\\Resin').GetTask('ResinDaemon')");
    expect(script).toContain("[int]$task.State");
    expect(script).toContain("EnginePID");
    expect(script).toContain("$command = [string]$action.Path");
    expect(script).toContain("ConvertTo-Json -Compress");
    expect(() => windowsTaskStatusScript("\\ResinTest-It's")).toThrow(
      /Invalid Windows scheduled task name/,
    );
  });

  it("reports the running task and its host PID through the manager", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(path.join(resinHome, "services", "windows-task.xml"), "<Task/>");
    const runner = scriptedRunner([RUNNING]);
    const status = await createManager(runner, fsBridge).status();

    expect(status).toMatchObject({
      installed: true,
      active: true,
      enabled: true,
      serviceName: WINDOWS_TASK_DEFAULT_NAME,
      state: "running",
      pid: 4242,
    });
    expect(runner.calls[0]?.cmd).toBe(POWERSHELL);
    expect(runner.calls[0]?.args.slice(0, 6)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
  });

  it("reports not installed without running commands when no definition exists", async () => {
    const runner = scriptedRunner([RUNNING]);
    expect(await createManager(runner).status()).toMatchObject({
      installed: false,
      active: false,
      state: "not_installed",
    });
    expect(runner.calls).toEqual([]);
  });

  it("fails closed when the query itself fails", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    await fsBridge.writeFile(path.join(resinHome, "services", "windows-task.xml"), "<Task/>");
    const runner: ServiceCommandRunner = {
      run: async () => ({ stdout: "", stderr: "Access is denied.", exitCode: 1 }),
    };
    await expect(createManager(runner, fsBridge).status()).rejects.toThrow(/Access is denied/);
  });
});

describe("Windows scheduled task lifecycle", () => {
  it("copies the host, persists the XML, registers with schtasks /XML and runs the task", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const hostFiles = recordingHostFiles();
    const runner = scriptedRunner([MISSING]);
    const result = await createManager(runner, fsBridge, hostFiles).install();
    const xmlPath = path.join(resinHome, "services", "windows-task.xml");

    expect(result).toMatchObject({
      success: true,
      enabled: true,
      started: true,
      unitPath: xmlPath,
      serviceName: WINDOWS_TASK_DEFAULT_NAME,
    });
    expect(hostFiles.installed).toEqual([
      [
        "C:\\release\\resin-service-host.exe",
        path.join(resinHome, "services", "resin-service-host.exe"),
      ],
    ]);
    expect(await fsBridge.readFile(xmlPath)).toBe(result.unitContent);
    expect(
      runner.calls.map((call) =>
        call.cmd === POWERSHELL ? "query" : [call.cmd, ...call.args].join(" "),
      ),
    ).toEqual([
      "query",
      `${SCHTASKS} /Create /TN ${WINDOWS_TASK_DEFAULT_NAME} /XML ${xmlPath} /F`,
      "query",
      `${SCHTASKS} /Run /TN ${WINDOWS_TASK_DEFAULT_NAME}`,
    ]);
  });

  it("never replaces, runs, stops or deletes a task that belongs to another Resin home", async () => {
    const foreign = JSON.stringify({
      installed: true,
      state: 4,
      enabled: true,
      pid: 77,
      command: "C:\\Users\\dev\\.resin\\services\\resin-service-host.exe",
    });
    const runner = scriptedRunner([foreign]);
    const manager = createManager(runner);

    expect((await manager.install()).error).toMatch(/belongs to another Resin home/);
    await expect(manager.start()).rejects.toThrow(/belongs to another Resin home/);
    await expect(manager.stop()).rejects.toThrow(/belongs to another Resin home/);
    expect((await manager.uninstall()).success).toBe(false);
    expect(runner.calls.filter((call) => call.cmd === SCHTASKS)).toEqual([]);
  });

  it("accepts its own task, comparing the host path case-insensitively", async () => {
    const own = JSON.stringify({
      installed: true,
      state: 3,
      enabled: true,
      command: path.join(resinHome, "services", "resin-service-host.exe").toUpperCase(),
    });
    const runner = scriptedRunner([own]);
    await createManager(runner).start();
    expect(
      runner.calls.filter((call) => call.cmd === SCHTASKS).map((call) => call.args[0]),
    ).toEqual(["/Run"]);
  });

  it("reports a registration failure instead of claiming success", async () => {
    const runner = scriptedRunner([MISSING], {
      "/Create": { stdout: "", stderr: "ERROR: Access is denied.", exitCode: 1 },
    });
    const result = await createManager(runner).install();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Access is denied");
    expect(runner.calls.some((call) => call.args[0] === "/Run")).toBe(false);
  });

  it("stops gracefully through the supervisor's stop request before ending the task", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const requestPath = serviceStopRequestPath(resinHome);
    const statuses = [RUNNING, RUNNING, READY];
    const runner = scriptedRunner(statuses);
    let requestSeen = false;
    const observingRunner: ServiceCommandRunner = {
      async run(cmd, args) {
        requestSeen ||= await fsBridge.exists(requestPath);
        return runner.run(cmd, args);
      },
    };

    await createManager(observingRunner, fsBridge).stop();

    expect(requestSeen).toBe(true);
    expect(runner.calls.some((call) => call.args[0] === "/End")).toBe(false);
    expect(await fsBridge.exists(requestPath)).toBe(false);
  });

  it("ends the task when the supervisor does not stop within the grace period", async () => {
    const runner = scriptedRunner([RUNNING, RUNNING, RUNNING, RUNNING, RUNNING, RUNNING, READY]);
    await createManager(runner).stop();
    expect(runner.calls.filter((call) => call.cmd === SCHTASKS).map((call) => call.args)).toEqual([
      ["/End", "/TN", WINDOWS_TASK_DEFAULT_NAME],
    ]);
  });

  it("restarts as stop then run, and toggles the logon trigger via /Change", async () => {
    const runner = scriptedRunner([READY]);
    const manager = createManager(runner);
    await manager.restart();
    await manager.disable();
    await manager.enable();
    expect(runner.calls.filter((call) => call.cmd === SCHTASKS).map((call) => call.args)).toEqual([
      ["/Run", "/TN", WINDOWS_TASK_DEFAULT_NAME],
      ["/Change", "/TN", WINDOWS_TASK_DEFAULT_NAME, "/DISABLE"],
      ["/Change", "/TN", WINDOWS_TASK_DEFAULT_NAME, "/ENABLE"],
    ]);
  });

  it("uninstalls: ends, deletes the task and its empty folder, removes the XML and host", async () => {
    const fsBridge = new InMemoryConfigFsBridge();
    const xmlPath = path.join(resinHome, "services", "windows-task.xml");
    await fsBridge.writeFile(xmlPath, "<Task/>");
    const hostFiles = recordingHostFiles();
    const runner = scriptedRunner([RUNNING, RUNNING, READY]);

    const result = await createManager(runner, fsBridge, hostFiles).uninstall();

    expect(result).toEqual({
      success: true,
      unitPath: xmlPath,
      stopped: true,
      disabled: true,
      removed: true,
    });
    expect(runner.calls.filter((call) => call.cmd === SCHTASKS).map((call) => call.args)).toEqual([
      ["/Delete", "/TN", WINDOWS_TASK_DEFAULT_NAME, "/F"],
    ]);
    expect(runner.calls.at(-1)?.script).toContain("DeleteFolder('Resin', 0)");
    expect(await fsBridge.exists(xmlPath)).toBe(false);
    expect(hostFiles.removed).toEqual([path.join(resinHome, "services", "resin-service-host.exe")]);
  });

  it("reports files it cannot remove (Windows file locks) instead of swallowing them", async () => {
    const locked = path.join(resinHome, "services", "resin-service-host.exe");
    const runner = scriptedRunner([READY]);
    const result = await createManager(
      runner,
      new InMemoryConfigFsBridge(),
      recordingHostFiles([locked]),
    ).uninstall();
    expect(result.success).toBe(false);
    expect(result.removed).toBe(false);
    expect(result.error).toContain(locked);
  });

  it("reports a failed task deletion", async () => {
    const runner = scriptedRunner([READY], {
      "/Delete": { stdout: "", stderr: "ERROR: Access is denied.", exitCode: 1 },
    });
    const result = await createManager(runner).uninstall();
    expect(result.success).toBe(false);
    expect(result.disabled).toBe(false);
    expect(result.error).toContain("Access is denied");
  });

  it("refuses login-session commands for a custom home without an injected runner", async () => {
    const manager = new WindowsTaskUserServiceManager({
      homeDir,
      resinHome,
      windowsTask: { userSid: SID, systemEnv: SYSTEM_ENV },
    });
    await expect(manager.start()).rejects.toThrow(/custom home directory/);
  });

  it("allows a custom home with an explicitly named task (qualification runs)", () => {
    const named = new WindowsTaskUserServiceManager({
      homeDir,
      resinHome,
      windowsTask: {
        userSid: SID,
        systemEnv: { ...SYSTEM_ENV, RESIN_WINDOWS_TASK_NAME: "\\ResinTest-Qual" },
      },
    });
    expect(named.backend.explicitTaskName).toBe(true);
    expect(named.serviceName).toBe("\\ResinTest-Qual");
    expect(
      new WindowsTaskUserServiceManager({
        homeDir,
        resinHome,
        windowsTask: { userSid: SID, systemEnv: SYSTEM_ENV },
      }).backend.explicitTaskName,
    ).toBe(false);
  });
});

describe("Windows task naming and discovery", () => {
  it("defaults to \\Resin\\ResinDaemon and honours RESIN_WINDOWS_TASK_NAME", () => {
    expect(resolveWindowsTaskName({})).toBe("\\Resin\\ResinDaemon");
    expect(resolveWindowsTaskName({ RESIN_WINDOWS_TASK_NAME: "\\ResinTest-Daemon" })).toBe(
      "\\ResinTest-Daemon",
    );
    expect(() => resolveWindowsTaskName({ RESIN_WINDOWS_TASK_NAME: "Resin|x" })).toThrow();
    expect(splitWindowsTaskName("\\ResinTest-Daemon")).toEqual({
      folder: "\\",
      name: "ResinTest-Daemon",
    });
    expect(windowsTaskFolderCleanupScript("\\ResinTest-Daemon")).toBe("exit 0");
  });

  it("selects the scheduled-task backend for the windows platform", () => {
    const manager = createUserServiceManager({
      platform: "windows",
      homeDir,
      resinHome,
      windowsTask: { userSid: SID, systemEnv: SYSTEM_ENV },
    });
    expect(manager).toBeInstanceOf(WindowsTaskUserServiceManager);
    expect(manager.platform).toBe("windows-task");
    expect(manager.getUnitPath()).toBe(path.join(resinHome, "services", "windows-task.xml"));
  });

  it("parses the SID from whoami CSV output", () => {
    expect(parseWhoamiSid(`"cooper\\lcchr","${SID}"\r\n`)).toBe(SID);
    expect(() => parseWhoamiSid("INFO: nothing")).toThrow(/SID/);
  });

  it("prefers the active release's service host prebuild", () => {
    const expected = path.join(
      resinHome,
      "current",
      "node_modules",
      "@resin",
      "windows-security",
      "prebuilds",
      "win32-arm64",
      "resin-service-host.exe",
    );
    expect(
      resolveServiceHostSourcePath(resinHome, "arm64", (candidate) => candidate === expected),
    ).toBe(expected);
    expect(() => resolveServiceHostSourcePath(resinHome, "arm64", () => false)).toThrow(
      /service host/,
    );
  });
});
