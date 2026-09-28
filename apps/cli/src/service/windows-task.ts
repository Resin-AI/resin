/**
 * Native Windows user service: a per-user Scheduled Task.
 *
 * The task starts `resin-service-host.exe` at logon for the current user only
 * (InteractiveToken, LeastPrivilege). The host is windowless and runs the
 * service supervisor (`node.exe <cli> __service-supervisor ...`) inside a
 * kill-on-close Job object, so ending the task stops the whole process tree.
 * The supervisor respawns a crashed daemon; the host restarts a failed
 * supervisor; a clean exit (including a tripped circuit breaker) ends the task.
 *
 * Registration uses `schtasks /Create /XML` (no administrator rights needed).
 * Status is read through the Task Scheduler COM API from Windows PowerShell as
 * JSON with numeric states, never from localized `schtasks` text.
 */
//
// This module is reachable from the bundled standalone installer helper, so it
// must not import @resin/windows-security or @resin/observer: the user SID comes
// from whoami.exe, the host executable is resolved lazily from the installed
// release, and a graceful stop is requested through a file the supervisor watches.
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { setTimeout as waitForTimeout } from "node:timers/promises";
import { type ConfigFsBridge, defaultFsBridge } from "@resin/harness-contracts";
import { z } from "zod";

export const WINDOWS_TASK_DEFAULT_NAME = "\\Resin\\ResinDaemon";
/** Overrides the task path, e.g. `\ResinTest-Daemon` for qualification runs. */
export const WINDOWS_TASK_NAME_ENV = "RESIN_WINDOWS_TASK_NAME";
export const WINDOWS_SERVICE_HOST_FILE = "resin-service-host.exe";
export const WINDOWS_TASK_XML_FILE = "windows-task.xml";
/** The host restarts a failed supervisor after this delay (Task Scheduler's own minimum is 1 minute). */
export const WINDOWS_HOST_RESTART_DELAY_SECONDS = 60;
export const WINDOWS_HOST_RESTART_LIMIT = 999;
/** Written by `stop()`; the service supervisor watches it and shuts down gracefully. */
export const SERVICE_STOP_REQUEST_FILE = "service-stop.request";

export function serviceStopRequestPath(resinHome: string): string {
  return path.join(resinHome, "run", SERVICE_STOP_REQUEST_FILE);
}

const TASK_NAME_PATTERN = /^\\(?:[A-Za-z0-9 ._-]+\\)*[A-Za-z0-9._-][A-Za-z0-9 ._-]*$/;
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

export function resolveWindowsTaskName(
  env: Record<string, string | undefined> = process.env,
): string {
  const requested = env[WINDOWS_TASK_NAME_ENV]?.trim();
  const taskName = requested && requested.length > 0 ? requested : WINDOWS_TASK_DEFAULT_NAME;
  assertValidTaskName(taskName);
  return taskName;
}

function assertValidTaskName(taskName: string): void {
  if (!TASK_NAME_PATTERN.test(taskName)) {
    throw new Error(
      `Invalid Windows scheduled task name ${JSON.stringify(taskName)}; expected a path such as ${WINDOWS_TASK_DEFAULT_NAME}`,
    );
  }
}

/** Splits `\Folder\Name` into the Task Scheduler folder (`\Folder`) and task name. */
export function splitWindowsTaskName(taskName: string): { folder: string; name: string } {
  assertValidTaskName(taskName);
  const index = taskName.lastIndexOf("\\");
  return { folder: index === 0 ? "\\" : taskName.slice(0, index), name: taskName.slice(index + 1) };
}

/**
 * Quotes one argument for a Windows command line so that CommandLineToArgvW and
 * the MSVC runtime (node.exe) read it back unchanged.
 */
export function quoteWindowsArgument(argument: string): string {
  if (argument.length > 0 && !/[\s"]/.test(argument)) {
    return argument;
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
    } else {
      quoted += `${"\\".repeat(backslashes)}${character}`;
    }
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

export function formatWindowsCommandLine(argv: readonly string[]): string {
  return argv.map(quoteWindowsArgument).join(" ");
}

/**
 * Escapes text for the task XML. Output is pure ASCII (non-ASCII becomes a
 * numeric character reference), so the file needs no encoding declaration and
 * `schtasks /XML` reads it regardless of the console code page.
 */
export function escapeTaskXml(value: string): string {
  let escaped = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      codePoint === 0xfffe ||
      codePoint === 0xffff
    ) {
      throw new Error("Scheduled task values cannot contain control characters");
    }
    switch (character) {
      case "&":
        escaped += "&amp;";
        break;
      case "<":
        escaped += "&lt;";
        break;
      case ">":
        escaped += "&gt;";
        break;
      case '"':
        escaped += "&quot;";
        break;
      case "'":
        escaped += "&apos;";
        break;
      default:
        escaped += codePoint > 0x7e ? `&#x${codePoint.toString(16).toUpperCase()};` : character;
    }
  }
  return escaped;
}

export interface WindowsTaskDefinition {
  readonly userSid: string;
  readonly hostPath: string;
  readonly hostArguments: readonly string[];
  readonly workingDirectory: string;
}

/** Builds the Task Scheduler XML (schema 1.2) for the per-user Resin task. */
export function buildWindowsTaskXml(definition: WindowsTaskDefinition): string {
  if (!SID_PATTERN.test(definition.userSid)) {
    throw new Error(`Invalid Windows user SID: ${definition.userSid}`);
  }
  const sid = escapeTaskXml(definition.userSid);
  return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Resin</Author>
    <Description>Resin background daemon for this user. Managed by resin; remove with resin uninstall.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeTaskXml(definition.hostPath)}</Command>
      <Arguments>${escapeTaskXml(formatWindowsCommandLine(definition.hostArguments))}</Arguments>
      <WorkingDirectory>${escapeTaskXml(definition.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export interface ServiceHostArgumentsInput {
  readonly resinHome: string;
  readonly nodePath: string;
  readonly supervisorArguments: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** Arguments for resin-service-host.exe: log redirection, environment, then the supervisor argv. */
export function buildServiceHostArguments(input: ServiceHostArgumentsInput): string[] {
  const logDir = path.win32.join(input.resinHome, "logs");
  const environment: Record<string, string> = {
    ...input.env,
    RESIN_HOME: input.resinHome,
    NODE_ENV: "production",
  };
  const args = [
    "--stdout",
    path.win32.join(logDir, "daemon.stdout.log"),
    "--stderr",
    path.win32.join(logDir, "daemon.stderr.log"),
    "--cwd",
    input.resinHome,
    "--restart-delay-seconds",
    String(WINDOWS_HOST_RESTART_DELAY_SECONDS),
    "--restart-limit",
    String(WINDOWS_HOST_RESTART_LIMIT),
    "--path-prepend",
    path.win32.dirname(input.nodePath),
  ];
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid service environment variable name: ${name}`);
    }
    // The task keeps the logon PATH; the host prepends the Node directory instead.
    if (name.toUpperCase() === "PATH") continue;
    args.push("--env", `${name}=${value}`);
  }
  args.push("--", ...input.supervisorArguments);
  return args;
}

const TaskStatusSchema = z.union([
  z.object({ installed: z.literal(false) }),
  z.object({
    installed: z.literal(true),
    state: z.number().int().min(0).max(4),
    enabled: z.boolean(),
    lastTaskResult: z.number().int().nullable().optional(),
    pid: z.number().int().nullable().optional(),
    command: z.string().nullable().optional(),
  }),
]);

/** Task Scheduler TASK_STATE values. */
const TASK_STATES: Record<number, WindowsTaskStateName> = {
  0: "unknown",
  1: "disabled",
  2: "queued",
  3: "ready",
  4: "running",
};

export type WindowsTaskStateName = "unknown" | "disabled" | "queued" | "ready" | "running";

export interface WindowsTaskStatus {
  readonly installed: boolean;
  readonly state: WindowsTaskStateName | "not_installed";
  readonly running: boolean;
  readonly enabled: boolean;
  readonly lastTaskResult?: number;
  readonly pid?: number;
  /** The program the task's action runs (identifies which Resin home owns it). */
  readonly command?: string;
}

/** Parses the JSON printed by {@link windowsTaskStatusScript}. */
export function parseWindowsTaskStatus(stdout: string): WindowsTaskStatus {
  const trimmed = stdout.trim().replace(/^\uFEFF/, "");
  const lastLine =
    trimmed
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .at(-1) ?? "";
  let parsed: z.infer<typeof TaskStatusSchema>;
  try {
    parsed = TaskStatusSchema.parse(JSON.parse(lastLine));
  } catch {
    throw new Error("Unrecognized scheduled task status output");
  }
  if (!parsed.installed) {
    return { installed: false, state: "not_installed", running: false, enabled: false };
  }
  const state = TASK_STATES[parsed.state] ?? "unknown";
  const status: {
    installed: true;
    state: WindowsTaskStateName;
    running: boolean;
    enabled: boolean;
    lastTaskResult?: number;
    pid?: number;
    command?: string;
  } = { installed: true, state, running: state === "running", enabled: parsed.enabled };
  if (typeof parsed.command === "string" && parsed.command.length > 0) {
    status.command = parsed.command;
  }
  if (parsed.lastTaskResult !== null && parsed.lastTaskResult !== undefined) {
    status.lastTaskResult = parsed.lastTaskResult;
  }
  if (parsed.pid !== null && parsed.pid !== undefined && parsed.pid > 0) {
    status.pid = parsed.pid;
  }
  return status;
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// HRESULTs Task Scheduler returns for a missing folder or task.
const MISSING_TASK_HRESULTS = "-2147024894,-2147024893";

/** Windows PowerShell 5.1 script that prints the task state as one JSON line. */
export function windowsTaskStatusScript(taskName: string): string {
  const { folder, name } = splitWindowsTaskName(taskName);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$service = New-Object -ComObject Schedule.Service",
    "$service.Connect()",
    "try {",
    `  $task = $service.GetFolder(${powershellString(folder)}).GetTask(${powershellString(name)})`,
    "} catch {",
    `  if (@(${MISSING_TASK_HRESULTS}) -contains $_.Exception.HResult) { '{"installed":false}'; exit 0 }`,
    "  throw",
    "}",
    "$enginePid = $null",
    "foreach ($instance in @($task.GetInstances(0))) { $enginePid = [int]$instance.EnginePID; break }",
    "$command = $null",
    "foreach ($action in @($task.Definition.Actions)) { if ([int]$action.Type -eq 0) { $command = [string]$action.Path; break } }",
    "$status = [ordered]@{ installed = $true; state = [int]$task.State; enabled = [bool]$task.Enabled; lastTaskResult = [int64]$task.LastTaskResult; pid = $enginePid; command = $command }",
    "New-Object PSObject -Property $status | ConvertTo-Json -Compress",
  ].join("\n");
}

/** Removes the task folder when Resin's task was the last one in it. */
export function windowsTaskFolderCleanupScript(taskName: string): string {
  const { folder } = splitWindowsTaskName(taskName);
  if (folder === "\\") {
    return "exit 0";
  }
  const parent = folder.slice(0, folder.lastIndexOf("\\")) || "\\";
  const leaf = folder.slice(folder.lastIndexOf("\\") + 1);
  return [
    "$ErrorActionPreference = 'Stop'",
    "$service = New-Object -ComObject Schedule.Service",
    "$service.Connect()",
    "try {",
    `  $folder = $service.GetFolder(${powershellString(folder)})`,
    "} catch {",
    `  if (@(${MISSING_TASK_HRESULTS}) -contains $_.Exception.HResult) { exit 0 }`,
    "  throw",
    "}",
    "if ($folder.GetTasks(1).Count -gt 0 -or $folder.GetFolders(0).Count -gt 0) { exit 0 }",
    `$service.GetFolder(${powershellString(parent)}).DeleteFolder(${powershellString(leaf)}, 0)`,
  ].join("\n");
}

/** `powershell.exe -EncodedCommand` payload: base64 of the UTF-16LE script. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function windowsSystemExecutable(
  name: "schtasks.exe" | "whoami.exe",
  env: Record<string, string | undefined> = process.env,
): string {
  return path.win32.join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", name);
}

/** Windows PowerShell 5.1, which every supported Windows ships. */
export function windowsPowerShellExecutable(
  env: Record<string, string | undefined> = process.env,
): string {
  return path.win32.join(
    env.SystemRoot ?? env.windir ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function powerShellArguments(script: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encodePowerShellCommand(script),
  ];
}

/** Parses `whoami /user /fo csv /nh` output (`"domain\\user","S-1-5-..."`). */
export function parseWhoamiSid(stdout: string): string {
  const match = stdout.match(/"(S-1-\d+(?:-\d+)+)"/);
  if (!match?.[1]) {
    throw new Error("Could not determine the current Windows user SID");
  }
  return match[1];
}

/** The current user's SID from whoami.exe (pure JS; no native helper needed). */
export function currentUserSidFromWhoami(
  env: Record<string, string | undefined> = process.env,
): string {
  const stdout = execFileSync(
    windowsSystemExecutable("whoami.exe", env),
    ["/user", "/fo", "csv", "/nh"],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    },
  );
  return parseWhoamiSid(stdout);
}

/**
 * Locates the service host shipped with the installed release: the active
 * version's `@resin/windows-security` prebuild, else the one next to this CLI.
 */
export function resolveServiceHostSourcePath(
  resinHome: string,
  arch: string = process.arch,
  exists: (candidate: string) => boolean = fsSync.existsSync,
): string {
  const relative = path.join("prebuilds", `win32-${arch}`, WINDOWS_SERVICE_HOST_FILE);
  const candidates = [
    path.join(resinHome, "current", "node_modules", "@resin", "windows-security", relative),
  ];
  try {
    const packageJson = createRequire(import.meta.url).resolve(
      "@resin/windows-security/package.json",
    );
    candidates.push(path.join(path.dirname(packageJson), relative));
  } catch {
    // Not resolvable from here (e.g. the standalone installer helper).
  }
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new Error(
      `Resin service host (${WINDOWS_SERVICE_HOST_FILE}) not found; looked in: ${candidates.join(", ")}. Build it with \`node packages/windows-security/scripts/build-native.mjs\`.`,
    );
  }
  return found;
}

/** Files the Windows service backend copies next to its task definition. */
export interface WindowsServiceHostFiles {
  /** Copies `source` to `target`, moving a locked (running) target aside first. */
  installHost(source: string, target: string): Promise<void>;
  /** Removes the host and any copies moved aside; returns paths it could not remove. */
  removeHost(target: string): Promise<string[]>;
}

function isFileLockError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES")
  );
}

async function sameFileContent(left: string, right: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
    return a.equals(b);
  } catch {
    return false;
  }
}

export const nodeWindowsServiceHostFiles: WindowsServiceHostFiles = {
  async installHost(source, target) {
    if (await sameFileContent(source, target)) return;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.copyFile(source, target);
    } catch (error) {
      if (!isFileLockError(error)) throw error;
      // A running executable cannot be overwritten but can be renamed.
      await fs.rename(target, `${target}.${Date.now()}.old`);
      await fs.copyFile(source, target);
    }
  },
  async removeHost(target) {
    const failures: string[] = [];
    const directory = path.dirname(target);
    const base = path.basename(target);
    let names: string[] = [];
    try {
      names = await fs.readdir(directory);
    } catch {
      return failures;
    }
    for (const name of names) {
      if (name !== base && !(name.startsWith(`${base}.`) && name.endsWith(".old"))) continue;
      const candidate = path.join(directory, name);
      try {
        // No maxRetries: async fs.rm with retries never settles on a mapped image (Node 24).
        await fs.rm(candidate, { force: true });
      } catch {
        failures.push(candidate);
      }
    }
    return failures;
  },
};

export interface ServiceCommandRunnerLike {
  run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface WindowsTaskBackendOptions {
  readonly taskName?: string;
  readonly userSid?: string | (() => string);
  readonly serviceHostSourcePath?: string | (() => string);
  readonly hostFiles?: WindowsServiceHostFiles;
  readonly wait?: (delayMs: number) => Promise<void>;
  readonly stopTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly systemEnv?: Record<string, string | undefined>;
}

export interface WindowsTaskBackendContext {
  readonly homeDir: string;
  readonly resinHome: string;
  readonly runner: ServiceCommandRunnerLike;
  readonly fsBridge?: ConfigFsBridge;
}

/**
 * Task lifecycle primitives (register, run, end, delete, query) behind the
 * `UserServiceManager` implementation in manager.ts.
 */
export class WindowsTaskBackend {
  readonly taskName: string;
  /** The task name was chosen explicitly (option or RESIN_WINDOWS_TASK_NAME), not defaulted. */
  readonly explicitTaskName: boolean;
  readonly resinHome: string;
  readonly homeDir: string;
  private readonly runner: ServiceCommandRunnerLike;
  private readonly fsBridge: ConfigFsBridge;
  private readonly options: WindowsTaskBackendOptions;
  private readonly systemEnv: Record<string, string | undefined>;
  private cachedSid?: string;

  constructor(context: WindowsTaskBackendContext, options: WindowsTaskBackendOptions = {}) {
    this.systemEnv = options.systemEnv ?? process.env;
    this.taskName = options.taskName ?? resolveWindowsTaskName(this.systemEnv);
    this.explicitTaskName =
      options.taskName !== undefined ||
      (this.systemEnv[WINDOWS_TASK_NAME_ENV]?.trim().length ?? 0) > 0;
    assertValidTaskName(this.taskName);
    this.resinHome = context.resinHome;
    this.homeDir = context.homeDir;
    this.runner = context.runner;
    this.fsBridge = context.fsBridge ?? defaultFsBridge;
    this.options = options;
  }

  get servicesDir(): string {
    return path.join(this.resinHome, "services");
  }

  get xmlPath(): string {
    return path.join(this.servicesDir, WINDOWS_TASK_XML_FILE);
  }

  get hostPath(): string {
    return path.join(this.servicesDir, WINDOWS_SERVICE_HOST_FILE);
  }

  userSid(): string {
    if (this.cachedSid === undefined) {
      const configured = this.options.userSid;
      this.cachedSid =
        typeof configured === "string"
          ? configured
          : configured instanceof Function
            ? configured()
            : currentUserSidFromWhoami(this.systemEnv);
    }
    return this.cachedSid;
  }

  private serviceHostSource(): string {
    const configured = this.options.serviceHostSourcePath;
    if (typeof configured === "string") return configured;
    if (configured instanceof Function) return configured();
    return resolveServiceHostSourcePath(this.resinHome);
  }

  private schtasks(args: string[]) {
    return this.runner.run(windowsSystemExecutable("schtasks.exe", this.systemEnv), args);
  }

  private powershell(script: string) {
    return this.runner.run(
      windowsPowerShellExecutable(this.systemEnv),
      powerShellArguments(script),
    );
  }

  private async wait(delayMs: number): Promise<void> {
    if (this.options.wait) {
      await this.options.wait(delayMs);
      return;
    }
    await waitForTimeout(delayMs);
  }

  /** Copies the host executable into the Resin home and writes the task XML. */
  async writeDefinition(xml: string): Promise<void> {
    await this.fsBridge.mkdirp(this.servicesDir);
    await this.fsBridge.mkdirp(path.join(this.resinHome, "logs"));
    await (this.options.hostFiles ?? nodeWindowsServiceHostFiles).installHost(
      this.serviceHostSource(),
      this.hostPath,
    );
    await this.fsBridge.writeFile(this.xmlPath, xml);
  }

  /** Registers (or replaces) the task from the XML on disk. */
  async register(): Promise<void> {
    this.assertOwned(await this.query());
    const result = await this.schtasks([
      "/Create",
      "/TN",
      this.taskName,
      "/XML",
      this.xmlPath,
      "/F",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to register scheduled task ${this.taskName}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
  }

  /**
   * Refuses to touch a task registered for another Resin home (its action runs a
   * different host copy), e.g. the real service when working on a test home.
   */
  assertOwned(status: WindowsTaskStatus): void {
    if (!status.installed || status.command === undefined) return;
    const normalize = (value: string) => path.win32.normalize(value).toLowerCase();
    if (normalize(status.command) !== normalize(this.hostPath)) {
      throw new Error(
        `Scheduled task ${this.taskName} belongs to another Resin home (it runs ${status.command}, not ${this.hostPath}); set ${WINDOWS_TASK_NAME_ENV} to use a different task.`,
      );
    }
  }

  async query(): Promise<WindowsTaskStatus> {
    const result = await this.powershell(windowsTaskStatusScript(this.taskName));
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to query scheduled task ${this.taskName}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
    return parseWindowsTaskStatus(result.stdout);
  }

  async run(): Promise<void> {
    this.assertOwned(await this.query());
    await this.clearStopRequest();
    const result = await this.schtasks(["/Run", "/TN", this.taskName]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to start scheduled task ${this.taskName}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const result = await this.schtasks([
      "/Change",
      "/TN",
      this.taskName,
      enabled ? "/ENABLE" : "/DISABLE",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to ${enabled ? "enable" : "disable"} scheduled task ${this.taskName}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
  }

  private async waitUntilStopped(timeoutMs: number): Promise<boolean> {
    const interval = this.options.pollIntervalMs ?? 250;
    for (let elapsed = 0; ; elapsed += interval) {
      const status = await this.query();
      if (!status.running) return true;
      if (elapsed >= timeoutMs) return false;
      await this.wait(interval);
    }
  }

  /**
   * Stops the task: writes the stop request the supervisor watches (it asks the
   * daemon to drain over IPC, then the supervisor and host exit cleanly), and
   * ends the task if it is still running after the grace period. Ending it
   * closes the host's job, which kills the whole tree.
   */
  async stop(): Promise<{ graceful: boolean; wasRunning: boolean }> {
    const initial = await this.query();
    this.assertOwned(initial);
    if (!initial.installed || !initial.running) {
      await this.clearStopRequest();
      return { graceful: true, wasRunning: false };
    }
    const requestPath = serviceStopRequestPath(this.resinHome);
    let requested = false;
    try {
      await this.fsBridge.mkdirp(path.dirname(requestPath));
      await this.fsBridge.writeFile(requestPath, `${new Date().toISOString()}\n`);
      requested = true;
    } catch {
      // Fall through to ending the task.
    }
    if (requested && (await this.waitUntilStopped(this.options.stopTimeoutMs ?? 20_000))) {
      await this.clearStopRequest();
      return { graceful: true, wasRunning: true };
    }
    const end = await this.schtasks(["/End", "/TN", this.taskName]);
    if (end.exitCode !== 0) {
      throw new Error(
        `Failed to end scheduled task ${this.taskName}: ${end.stderr || end.stdout || `exit code ${end.exitCode}`}`,
      );
    }
    if (!(await this.waitUntilStopped(5_000))) {
      throw new Error(`Scheduled task ${this.taskName} is still running after /End`);
    }
    await this.clearStopRequest();
    return { graceful: false, wasRunning: true };
  }

  /** A stale request would stop the next supervisor as soon as it starts. */
  async clearStopRequest(): Promise<void> {
    await this.fsBridge.unlink(serviceStopRequestPath(this.resinHome)).catch(() => undefined);
  }

  /** Deletes the task (and its folder when empty). Returns false when it did not exist. */
  async delete(): Promise<boolean> {
    const status = await this.query();
    if (!status.installed) return false;
    this.assertOwned(status);
    const result = await this.schtasks(["/Delete", "/TN", this.taskName, "/F"]);
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to delete scheduled task ${this.taskName}: ${result.stderr || result.stdout || `exit code ${result.exitCode}`}`,
      );
    }
    await this.powershell(windowsTaskFolderCleanupScript(this.taskName)).catch(() => undefined);
    return true;
  }

  /** Removes the persisted XML and host copy; returns paths that could not be removed. */
  async removeFiles(): Promise<string[]> {
    const failures: string[] = [];
    try {
      await this.fsBridge.unlink(this.xmlPath);
    } catch {
      failures.push(this.xmlPath);
    }
    // The host can hold its image open for a moment after the task ends.
    let remaining: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      remaining = await (this.options.hostFiles ?? nodeWindowsServiceHostFiles).removeHost(
        this.hostPath,
      );
      if (remaining.length === 0) break;
      await this.wait(500);
    }
    return [...failures, ...remaining];
  }
}
