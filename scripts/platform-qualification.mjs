#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { V1_SUPPORT_MATRIX } from "../apps/cli/dist/platform/platform.js";

// Qualification and smoke runs start real Resin binaries: they must never send error reports or
// usage events to production. An explicit DO_NOT_TRACK / RESIN_ERROR_REPORTING is respected.
if (process.env.DO_NOT_TRACK === undefined && process.env.RESIN_ERROR_REPORTING === undefined) {
  process.env.DO_NOT_TRACK = "1";
}

export { V1_SUPPORT_MATRIX };

export const REQUIRED_QUALIFICATION_LANES = V1_SUPPORT_MATRIX.qualificationLanes;

export const PINNED_NODE_VERSION = V1_SUPPORT_MATRIX.toolchain.node.pinned;
export const PINNED_PNPM_VERSION = V1_SUPPORT_MATRIX.toolchain.pnpm.pinned;
export const PINNED_DENO_VERSION = V1_SUPPORT_MATRIX.toolchain.deno.pinned;

const LANE_ASSET = Object.freeze(
  Object.fromEntries(
    V1_SUPPORT_MATRIX.platforms.map((p) => [p.id, p.id === "wsl" ? "wsl-x64" : p.id]),
  ),
);

/** Native Windows (win32) qualification lanes, qualified on Windows runners in PowerShell. */
export const WINDOWS_QUALIFICATION_LANES = Object.freeze(["windows-x64", "windows-arm64"]);

export function isWindowsLane(lane) {
  return WINDOWS_QUALIFICATION_LANES.includes(lane);
}

export function emitSupportMatrix(options = {}) {
  if (options.format === "json") {
    return JSON.stringify(V1_SUPPORT_MATRIX, null, 2);
  }
  return V1_SUPPORT_MATRIX;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function detectHostLane(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const release = options.release ?? os.release();
  let procVersion = options.procVersion;
  if (procVersion === undefined && platform === "linux") {
    try {
      procVersion = fs.readFileSync("/proc/version", "utf8");
    } catch {
      procVersion = "";
    }
  }
  const isWsl =
    platform === "linux" &&
    Boolean(
      env.WSL_DISTRO_NAME ||
        env.WSL_INTEROP ||
        /microsoft|wsl/i.test(String(release)) ||
        /microsoft|wsl/i.test(String(procVersion ?? "")),
    );
  if (isWsl) return "wsl";
  if (platform === "win32") {
    const windowsLane = `windows-${arch}`;
    return REQUIRED_QUALIFICATION_LANES.includes(windowsLane) ? windowsLane : null;
  }
  const lane = `${platform}-${arch}`;
  return REQUIRED_QUALIFICATION_LANES.includes(lane) ? lane : null;
}

export function hostEnvironment() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osType: os.type(),
    nodeVersion: process.version,
    lane: detectHostLane(),
    wslDistro: process.env.WSL_DISTRO_NAME ?? null,
    runnerName: process.env.RUNNER_NAME ?? null,
    runnerOs: process.env.RUNNER_OS ?? null,
    runnerArch: process.env.RUNNER_ARCH ?? null,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT ?? null,
  };
}

function runNode(entrypoint, args = [], options = {}) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 20_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function createQualificationCliDriver(installedRoot, sandboxDir, options = {}) {
  const withService = options.service === true;
  const driverPath = path.join(
    sandboxDir,
    withService ? "qualification-service-cli.mjs" : "qualification-cli.mjs",
  );
  const cliModuleUrl = pathToFileURL(
    path.join(installedRoot, "apps", "cli", "dist", "index.js"),
  ).href;
  fs.writeFileSync(
    driverPath,
    [
      `import { main } from ${JSON.stringify(cliModuleUrl)};`,
      "const exitCode = await main(process.argv.slice(2), {",
      "  initOptions: {",
      '    releaseMode: "local-test",',
      `    setupService: ${withService},`,
      `    autoStartService: ${withService},`,
      "  },",
      "});",
      "process.exitCode = exitCode;",
      "",
    ].join("\n"),
    "utf8",
  );
  return driverPath;
}

/**
 * Run a script under a Windows PowerShell dialect. `dialect` is "powershell" (Windows
 * PowerShell 5.1, powershell.exe) or "pwsh" (PowerShell 7+); the two are never mixed.
 */
export function runPowerShell(script, options = {}) {
  const executable = options.dialect === "pwsh" ? "pwsh" : "powershell.exe";
  const result = spawnSync(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/** Single-quoted PowerShell string literal. */
export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** Which Windows shells this host can run; PowerShell 5.1 is required, pwsh is optional. */
export function probeWindowsShells() {
  const versionScript = "$PSVersionTable.PSVersion.ToString(); $PSVersionTable.PSEdition";
  const describe = (dialect) => {
    const result = runPowerShell(versionScript, { dialect, timeoutMs: 30_000 });
    if (result.status !== 0) return null;
    const [version, edition] = result.stdout.trim().split(/\r?\n/);
    return { version: version?.trim() ?? null, edition: edition?.trim() ?? null };
  };
  const powershell = describe("powershell");
  if (!powershell || !powershell.version?.startsWith("5.")) {
    throw new Error(
      `Windows PowerShell 5.1 (powershell.exe) is required on native Windows lanes, found ${JSON.stringify(powershell)}`,
    );
  }
  const cmd = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "ver"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return {
    powershell,
    pwsh: describe("pwsh"),
    cmd: cmd.status === 0 ? (cmd.stdout ?? "").trim() : null,
  };
}

async function waitFor(check, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function terminateProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Best-effort cleanup.
  }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best-effort cleanup.
      }
    }
  }, 2000).unref();
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise((resolve) => child.once("exit", (code) => resolve(code))),
    sleep(timeoutMs).then(() => null),
  ]);
}

function readManifest(releaseDir) {
  const manifestPath = path.join(releaseDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Release manifest not found: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function resolveAsset(releaseDir, lane, manifest) {
  const assetId = LANE_ASSET[lane];
  const asset = manifest.assets?.[assetId];
  if (!asset?.filename || !asset?.sha256) {
    throw new Error(`Release manifest has no complete asset metadata for ${lane}`);
  }
  const archivePath = path.join(releaseDir, asset.filename);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Release artifact missing for ${lane}: ${archivePath}`);
  }
  const actualDigest = sha256File(archivePath);
  if (actualDigest !== asset.sha256) {
    throw new Error(
      `Release artifact digest mismatch for ${lane}: expected ${asset.sha256}, received ${actualDigest}`,
    );
  }
  return { assetId, asset, archivePath, actualDigest };
}

/**
 * Windows 10 1803+/11 ship bsdtar as %SystemRoot%\System32\tar.exe. Use it explicitly so a
 * GNU tar from Git for Windows on PATH (which misreads `C:` as a remote host) is never used.
 */
function tarExecutable() {
  if (process.platform !== "win32") return "tar";
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
}

function extractRelease(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const result = spawnSync(tarExecutable(), ["-xzf", archivePath, "-C", targetDir], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `Failed to extract release artifact: ${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  const installedRoot = path.join(targetDir, "resin");
  if (!fs.existsSync(installedRoot)) {
    throw new Error("Release artifact did not contain resin root directory");
  }
  return installedRoot;
}

function validatePlatformMetadata(installedRoot, lane, manifest) {
  const platformPath = path.join(installedRoot, "platform.json");
  const metadata = JSON.parse(fs.readFileSync(platformPath, "utf8"));
  const platformSpec = V1_SUPPORT_MATRIX.platforms.find((p) => p.id === lane);
  if (!platformSpec) {
    throw new Error(`Unknown qualification lane '${lane}' in support matrix`);
  }
  if (
    metadata.platform !== platformSpec.os ||
    metadata.arch !== platformSpec.arch ||
    Boolean(metadata.isWsl) !== platformSpec.isWsl
  ) {
    throw new Error(
      `Platform metadata mismatch for ${lane}: expected os=${platformSpec.os}, arch=${platformSpec.arch}, isWsl=${platformSpec.isWsl}; got ${JSON.stringify(metadata)}`,
    );
  }
  if (metadata.releaseVersion !== manifest.version) {
    throw new Error(
      `Platform release version ${metadata.releaseVersion} does not match manifest ${manifest.version}`,
    );
  }
  return metadata;
}

const REQUIRED_ARTIFACT_FILES = Object.freeze(["platform.json", "bin/resin", "bin/resin-daemon"]);

/** Windows launchers plus the lane's own native security helper and windowless service host. */
export function windowsArtifactFiles(arch) {
  const prebuilds = `node_modules/@resin/windows-security/prebuilds/win32-${arch}`;
  return Object.freeze([
    "bin/resin.cmd",
    "bin/resin-daemon.cmd",
    "bin/resin-gateway.cmd",
    `${prebuilds}/resin_windows_security.node`,
    `${prebuilds}/resin-service-host.exe`,
  ]);
}

export function requiredArtifactFiles(lane) {
  if (!isWindowsLane(lane)) return REQUIRED_ARTIFACT_FILES;
  const arch = lane.slice("windows-".length);
  return Object.freeze([...REQUIRED_ARTIFACT_FILES, ...windowsArtifactFiles(arch)]);
}

const PROPRIETARY_ARTIFACT_PATHS = Object.freeze([
  "apps/cloud",
  "apps/web",
  "packages/cloud-contracts",
]);

const PE_MACHINE_ARCH = Object.freeze({ 34404: "x64", 43620: "arm64" });

/**
 * The architecture a PE/COFF image targets ("x64" / "arm64"), or null when the file is not a
 * PE image (test-only packaging substitutes marked placeholder text for missing prebuilds).
 */
export function peImageArch(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.toString("latin1", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (
    peOffset + 6 > buffer.length ||
    buffer.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    return null;
  }
  return PE_MACHINE_ARCH[buffer.readUInt16LE(peOffset + 4)] ?? "unknown";
}

function validateArtifactLayout(installedRoot, lane) {
  const requiredFiles = requiredArtifactFiles(lane);
  const missingFiles = requiredFiles.filter((relativePath) => {
    const candidatePath = path.join(installedRoot, relativePath);
    return !fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile();
  });
  if (missingFiles.length > 0) {
    throw new Error(`Release artifact is missing required files: ${missingFiles.join(", ")}`);
  }
  const proprietaryArtifacts = PROPRIETARY_ARTIFACT_PATHS.filter((relativePath) =>
    fs.existsSync(path.join(installedRoot, relativePath)),
  );
  if (proprietaryArtifacts.length > 0) {
    throw new Error(
      `Release artifact contains proprietary cloud paths: ${proprietaryArtifacts.join(", ")}`,
    );
  }
  const layout = {
    requiredFiles: [...requiredFiles],
    verifiedFiles: requiredFiles.length,
    proprietaryArtifactsAbsent: true,
  };
  if (isWindowsLane(lane)) {
    // Record the native binaries' digests so the signing job can prove the prebuilds it
    // packages are byte-identical to the ones qualified here.
    const nativePrebuilds = {};
    for (const relativePath of requiredFiles.filter((file) => file.includes("/prebuilds/"))) {
      const filePath = path.join(installedRoot, relativePath);
      nativePrebuilds[path.posix.basename(relativePath)] = {
        path: relativePath,
        sha256: sha256File(filePath),
        sizeBytes: fs.statSync(filePath).size,
        peArch: peImageArch(filePath),
      };
    }
    layout.nativePrebuilds = nativePrebuilds;
  }
  return layout;
}

/**
 * Native lanes must ship real PE binaries for their own architecture. Artifact validation on
 * other hosts tolerates test-only placeholders, which the signing job never packages.
 */
function requireRealNativePrebuilds(layout, arch) {
  const wrong = Object.entries(layout.nativePrebuilds ?? {})
    .filter(([, record]) => record.peArch !== arch)
    .map(([name, record]) => `${name}: ${record.peArch ?? "placeholder"}`);
  if (wrong.length > 0) {
    throw new Error(
      `Release artifact ships native prebuilds that are not ${arch} PE images (${wrong.join(", ")}); run packages/windows-security/scripts/build-native.mjs --arch ${arch} before packaging`,
    );
  }
}

async function loadPackagedWindowsSecurity(installedRoot) {
  const entry = path.join(
    installedRoot,
    "node_modules",
    "@resin",
    "windows-security",
    "dist",
    "index.js",
  );
  if (!fs.existsSync(entry)) {
    throw new Error(`Packaged @resin/windows-security entry is missing: ${entry}`);
  }
  // The module lives inside the extracted artifact, so its path is only known at run time.
  const security = await import(pathToFileURL(entry).href);
  if (!security.isWindowsSecurityAvailable()) {
    throw new Error("Packaged @resin/windows-security native helper failed to load");
  }
  return security;
}

/**
 * Prove the running daemon's named pipe belongs to this user and this server, and that the
 * private Resin directories carry an owner-only DACL.
 */
async function verifyWindowsDaemonIsolationInProcess({ installedRoot, resinHome }) {
  const security = await loadPackagedWindowsSecurity(installedRoot);
  const pipeName = security.windowsDaemonPipeName(resinHome);
  const pipe = security.verifyPipeServer(pipeName);
  if (!pipe.ok) {
    throw new Error(`Daemon named pipe ${pipeName} failed verification: ${pipe.reason}`);
  }
  const privatePaths = [
    resinHome,
    path.join(resinHome, "state"),
    path.join(resinHome, "config"),
  ].filter((candidate) => fs.existsSync(candidate));
  const problems = privatePaths.flatMap((candidate) => {
    const acl = security.checkOwnerOnly(candidate);
    return acl.ok ? [] : acl.problems.map((problem) => `${candidate}: ${problem}`);
  });
  if (problems.length > 0) {
    throw new Error(`Private Resin paths are not owner-only: ${problems.join("; ")}`);
  }
  return {
    endpoint: "named-pipe",
    pipeName,
    pipeOwnerVerified: true,
    ownerOnlyPaths: privatePaths.length,
  };
}

/**
 * On POSIX the daemon listens on an explicit Unix socket path. On Windows every client and
 * the daemon derive the same `\\.\pipe\resin-daemon-<hash>` from the Resin home, so no
 * endpoint flag is passed.
 */
function daemonEndpointArgs(socketPath) {
  return process.platform === "win32" ? [] : ["--socket", socketPath];
}

/** Pin RESIN_HOME on Windows so the pipe name the daemon hashes is the one we verify. */
function daemonEnv(baseEnv, resinHome) {
  return process.platform === "win32" ? { ...baseEnv, RESIN_HOME: resinHome } : baseEnv;
}

/**
 * Invoke the packaged `.cmd` launchers through each Windows shell dialect present on the
 * host: Windows PowerShell 5.1 always, PowerShell 7+ when installed, and cmd.exe.
 */
function qualifyWindowsLaunchers(installedRoot, sandboxDir, manifest, shells) {
  const launcher = path.join(installedRoot, "bin", "resin.cmd");
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.NODE_PATH;
  const results = {};
  for (const dialect of ["powershell", "pwsh"]) {
    if (dialect === "pwsh" && !shells.pwsh) continue;
    const result = runPowerShell(`& ${psQuote(launcher)} --version; exit $LASTEXITCODE`, {
      dialect,
      cwd: sandboxDir,
      env,
    });
    if (result.status !== 0 || !result.stdout.includes(manifest.version)) {
      throw new Error(
        `Packaged resin.cmd --version failed under ${dialect}: ${result.stderr || result.stdout || result.error}`,
      );
    }
    results[dialect] = true;
  }
  const cmd = spawnSync(
    process.env.ComSpec || "cmd.exe",
    // `/s` strips the outermost quote pair, so the quoted launcher path survives spaces.
    ["/d", "/s", "/c", `""${launcher}" --version"`],
    {
      cwd: sandboxDir,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      windowsVerbatimArguments: true,
    },
  );
  if (cmd.status !== 0 || !(cmd.stdout ?? "").includes(manifest.version)) {
    throw new Error(
      `Packaged resin.cmd --version failed under cmd.exe: ${cmd.stderr || cmd.stdout}`,
    );
  }
  results.cmd = true;
  return results;
}

function qualifyCli(installedRoot, sandboxDir, manifest) {
  const cli = path.join(installedRoot, "bin", V1_SUPPORT_MATRIX.product.binaryName);
  const outside = path.join(sandboxDir, "outside-workspace");
  const dryRunHome = path.join(sandboxDir, "dry-run-home");
  const workspace = path.join(sandboxDir, "workspace");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const initCli = createQualificationCliDriver(installedRoot, sandboxDir);
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.NODE_PATH;

  const version = runNode(cli, ["--version"], { cwd: outside, env });
  if (version.status !== 0 || !version.stdout.includes(manifest.version)) {
    throw new Error(`Packaged CLI version command failed: ${version.stderr || version.stdout}`);
  }
  const help = runNode(cli, ["--help"], { cwd: outside, env });
  if (help.status !== 0 || !help.stdout.includes("Resin CLI")) {
    throw new Error(`Packaged CLI help command failed: ${help.stderr || help.stdout}`);
  }
  const initDryRun = runNode(
    initCli,
    [
      "init",
      "--dry-run",
      "--non-interactive",
      "--auto-approve",
      `--home=${dryRunHome}`,
      `--workspace=${workspace}`,
      "--json",
    ],
    { cwd: outside, env, timeoutMs: 30_000 },
  );
  if (initDryRun.status !== 0 || !initDryRun.stdout.includes('"success": true')) {
    throw new Error(`Packaged CLI init dry-run failed: ${initDryRun.stderr || initDryRun.stdout}`);
  }
  return {
    version: true,
    versionOutput: version.stdout.trim(),
    releaseVersion: manifest.version,
    help: true,
    initDryRun: true,
  };
}

async function qualifyDaemon(installedRoot, sandboxDir) {
  const daemonBin = path.join(installedRoot, "bin", "resin-daemon");
  const daemonHome = path.join(sandboxDir, "daemon-home");
  const socketPath = path.join(sandboxDir, "daemon.sock");
  const endpoint = daemonEndpointArgs(socketPath);
  fs.mkdirSync(daemonHome, { recursive: true });
  // HOME/USERPROFILE point at the sandbox too: the private-value store's default location
  // follows the user's profile, not RESIN_HOME/--home, so the real user's data stays untouched.
  const env = daemonEnv(
    {
      ...process.env,
      HOME: daemonHome,
      USERPROFILE: daemonHome,
      NODE_ENV: "production",
      RESIN_LOG_LEVEL: "silent",
      RESIN_CLOUD_SYNC_ENABLED: "false",
      RESIN_TELEMETRY_ENABLED: "false",
    },
    path.join(daemonHome, ".resin"),
  );
  delete env.NODE_PATH;

  const child = spawn(
    process.execPath,
    [daemonBin, "--foreground", "--home", daemonHome, ...endpoint],
    { cwd: sandboxDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    const statusResult = await waitFor(
      () => {
        const result = runNode(daemonBin, ["--status", "--home", daemonHome, ...endpoint], {
          cwd: sandboxDir,
          env,
          timeoutMs: 3000,
        });
        return result.status === 0 ? result : false;
      },
      { timeoutMs: 15_000, intervalMs: 200 },
    );
    const diagnostics = runNode(daemonBin, ["--diagnostics", "--home", daemonHome, ...endpoint], {
      cwd: sandboxDir,
      env,
      timeoutMs: 5000,
    });
    if (diagnostics.status !== 0) {
      throw new Error(
        `Packaged daemon diagnostics failed: ${diagnostics.stderr || diagnostics.stdout}`,
      );
    }
    const windowsIsolation =
      process.platform === "win32"
        ? await verifyWindowsDaemonIsolation(installedRoot, path.join(daemonHome, ".resin"))
        : undefined;
    const stop = runNode(daemonBin, ["--stop", "--home", daemonHome, ...endpoint], {
      cwd: sandboxDir,
      env,
      timeoutMs: 5000,
    });
    if (stop.status !== 0) {
      throw new Error(`Packaged daemon stop failed: ${stop.stderr || stop.stdout}`);
    }
    const exitCode = await waitForExit(child, 7000);
    if (exitCode === null) {
      throw new Error("Packaged daemon did not exit after authenticated stop command");
    }
    return {
      started: true,
      authenticatedStatus: true,
      diagnostics: true,
      stopped: true,
      endpoint: process.platform === "win32" ? "named-pipe" : "unix-socket",
      ...(windowsIsolation ? { windowsIsolation } : {}),
      statusOutput: statusResult.stdout.trim(),
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; daemon stdout=${stdout}; stderr=${stderr}`,
    );
  } finally {
    terminateProcess(child);
  }
}

function createRpcClient(child) {
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(String(message.id))) {
          const entry = pending.get(String(message.id));
          pending.delete(String(message.id));
          entry.resolve(message);
        }
      } catch {
        // Non-JSON diagnostic output is ignored; stderr is captured separately.
      }
    }
  });
  return {
    request(id, method, params = {}, timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const key = String(id);
        const timeout = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Timed out waiting for MCP response to ${method}`));
        }, timeoutMs);
        pending.set(key, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function qualifyMcp(installedRoot, sandboxDir) {
  const resinBin = path.join(installedRoot, "bin", "resin");
  const workspace = path.join(sandboxDir, "mcp-workspace");
  const mcpHome = path.join(sandboxDir, "mcp-home");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(mcpHome, { recursive: true });
  // The standalone gateway opens its state under the user's Resin home; keep it in the sandbox
  // so qualifying never touches (or reads) the real user's Resin data on any platform.
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOME: mcpHome,
    USERPROFILE: mcpHome,
    RESIN_HOME: path.join(mcpHome, ".resin"),
  };
  delete env.NODE_PATH;
  const child = spawn(
    process.execPath,
    [resinBin, "mcp", "--standalone", "--cwd", workspace, "--harness", "qualification"],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const rpc = createRpcClient(child);
  try {
    const initialized = await rpc.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "platform-qualification", version: "1.0.0" },
      capabilities: {},
    });
    if (initialized.error) throw new Error(`MCP initialize failed: ${JSON.stringify(initialized)}`);
    const listed = await rpc.request(2, "tools/list", {});
    if (listed.error) throw new Error(`MCP tools/list failed: ${JSON.stringify(listed)}`);
    const toolNames = (listed.result?.tools ?? []).map((tool) => tool.name);
    const expectedMetaTools = ["get_tool_schema", "invoke_tool", "manage_tools"];
    for (const metaTool of expectedMetaTools) {
      if (!toolNames.includes(metaTool)) {
        throw new Error(
          `MCP catalog did not include essential system meta-tool ${metaTool}: ${JSON.stringify(toolNames)}`,
        );
      }
    }
    if (toolNames.includes("search_tools")) {
      throw new Error("MCP catalog exposed search_tools without --enable-tool-search");
    }
    const removedUtilities = ["echo", "workspace_info", "fail_tool", "slow_tool"];
    for (const utility of removedUtilities) {
      if (toolNames.includes(utility)) {
        throw new Error(
          `MCP catalog unexpectedly leaked removed standalone utility ${utility}: ${JSON.stringify(toolNames)}`,
        );
      }
    }
    const called = await rpc.request(3, "tools/call", {
      name: "get_tool_schema",
      arguments: { toolId: "sys_invoke_tool" },
    });
    if (called.error) throw new Error(`MCP tools/call failed: ${JSON.stringify(called)}`);
    const rendered = JSON.stringify(called.result ?? {});
    if (!rendered.includes("invoke_tool")) {
      throw new Error(`MCP get_tool_schema invocation returned unexpected result: ${rendered}`);
    }
    return {
      initialized: true,
      catalogRefresh: true,
      toolCount: toolNames.length,
      searchDisabledByDefault: !toolNames.includes("search_tools"),
      toolInvocation: true,
    };
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; mcp stderr=${stderr}`,
    );
  } finally {
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    terminateProcess(child);
    await waitForExit(child, 3000);
  }
}
const OMP_QUALIFICATION_FIXTURE_LINES = `${[
  JSON.stringify({
    type: "session_lifecycle",
    lifecycleType: "start",
    harnessName: "omp",
    workspaceId: "ws_clean_home_1",
    timestamp: "2026-08-30T10:00:00.000Z",
    sessionId: "session-clean-qual-1",
  }),
  JSON.stringify({
    type: "message",
    role: "user",
    content: "Inspect the qualification status and run checks",
    timestamp: "2026-08-30T10:00:01.000Z",
    sessionId: "session-clean-qual-1",
    provider: "anthropic",
  }),
  JSON.stringify({
    type: "model_reasoning",
    reasoningContent: "Checking qualification invariants in clean home.",
    model: "claude-3-7-sonnet",
    provider: "anthropic",
    timestamp: "2026-08-30T10:00:02.000Z",
    sessionId: "session-clean-qual-1",
  }),
  JSON.stringify({
    type: "tool_call",
    toolName: "read",
    callId: "call_qual_1",
    parameters: { path: "package.json" },
    timestamp: "2026-08-30T10:00:03.000Z",
    sessionId: "session-clean-qual-1",
  }),
  JSON.stringify({
    type: "tool_result",
    callId: "call_qual_1",
    output: '{"name": "resin"}',
    timestamp: "2026-08-30T10:00:04.000Z",
    sessionId: "session-clean-qual-1",
  }),
  JSON.stringify({
    type: "message",
    role: "assistant",
    content: "Qualification checks verified successfully.",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    timestamp: "2026-08-30T10:00:05.000Z",
    sessionId: "session-clean-qual-1",
  }),
  JSON.stringify({
    lifecycleType: "settle",
    role: "candidate",
    reason: "Qualification completed",
    exitReason: "task_completed",
    harnessName: "omp",
    workspaceId: "ws_clean_home_1",
    timestamp: "2026-08-30T10:00:06.000Z",
    sessionId: "session-clean-qual-1",
  }),
].join("\n")}\n`;

async function ingestPackagedOmpFixtureInProcess({
  installedRoot,
  stateDbPath,
  transcriptPath,
  cloudUrl,
}) {
  const cacheBust = `qualification=${Date.now()}`;
  const [
    { TrajectoryCaptureRuntimeModule },
    { CloudObservationClient },
    { createLocalStateStore },
  ] = await Promise.all([
    import(
      `${pathToFileURL(path.join(installedRoot, "apps", "observer", "dist", "trajectory-capture-module.js")).href}?${cacheBust}`
    ),
    import(
      `${pathToFileURL(path.join(installedRoot, "apps", "observer", "dist", "cloud-runtime.js")).href}?${cacheBust}`
    ),
    import(
      `${pathToFileURL(path.join(installedRoot, "packages", "db", "dist", "index.js")).href}?${cacheBust}`
    ),
  ]);

  const store = createLocalStateStore({ path: stateDbPath });
  await store.initialize();
  const observationClient = new CloudObservationClient({
    identityProvider: async () => ({
      cloudUrl,
      accessToken: "test-qualification-token",
      accountId: "acc_qual_clean",
      workspaceId: "ws_clean_home_1",
      deviceId: "dev_clean_home_1",
      installationId: "inst_clean_home_1",
      userId: "usr_clean_home_1",
    }),
  });
  const captureModule = new TrajectoryCaptureRuntimeModule({
    store,
    observationClient,
    telemetryEnabled: true,
    now: () => Date.parse("2026-08-30T09:59:00.000Z"),
    remoteTelemetryConsent: {
      metadataTelemetryEnabled: true,
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
  });
  const sessionId = "session-clean-qual-1";
  const lines = OMP_QUALIFICATION_FIXTURE_LINES.trim().split("\n");
  const session = {
    sessionId,
    workspaceId: "ws_clean_home_1",
    harnessId: "omp",
    transcriptPath,
    status: "completed",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:06.000Z",
    metadata: {
      resinTrajectoryAttribution: {
        accountId: "acc_qual_clean",
        workspaceId: "ws_clean_home_1",
        ownerUserId: "usr_clean_home_1",
        projectId: "proj_qual_clean",
        candidateId: "candidate_qual_clean",
        toolId: "tool_qual_clean",
        toolVersion: "1.0.0",
        workloadId: "workload_qual_clean",
        trajectoryId: "trajectory_qual_clean",
        provider: "anthropic",
        model: "claude-3-7-sonnet",
        runtimeVersion: "1.0.0",
        role: "candidate",
      },
    },
  };
  const rawRecords = lines.map((rawPayload, index) => {
    const sequenceNumber = index + 1;
    const timestamp = JSON.parse(rawPayload).timestamp;
    return {
      recordId: `qualification-${sequenceNumber}`,
      sessionId,
      harnessId: "omp",
      sequenceNumber,
      timestamp,
      recordType: "transcript_line",
      rawPayload,
      cursor: {
        offset: sequenceNumber,
        line: sequenceNumber,
        sequence: sequenceNumber,
        timestamp,
      },
      metadata: { sourcePath: transcriptPath },
    };
  });

  try {
    const pipeline = captureModule.getNormalizationPipeline();
    const results = await pipeline.processBatch(rawRecords, {
      workspaceId: session.workspaceId,
      deferCommitUntilCloudAck: true,
    });
    const observations = results.flatMap((result) =>
      result.status === "success" && !result.isDuplicate ? [result.event] : [],
    );
    if (observations.length === 0) {
      throw new Error("Packaged OMP normalization produced no observations");
    }
    await observationClient.sendObservationBatch({
      batchId: "qualification-omp-clean-home",
      observations,
    });
    await pipeline.commitCloudAcknowledgedEvents(observations);
    await captureModule.getCursorManager().commitCheckpoint(sessionId, {
      offset: fs.statSync(transcriptPath).size,
      line: lines.length,
      sequence: lines.length,
      timestamp: "2026-08-30T10:00:06.000Z",
    });
  } finally {
    observationClient.dispose();
    store.close();
  }
}

/**
 * The MCP launch `resin init` writes into harness configs. POSIX installs launch the
 * `<resinHome>/bin/resin` shim; no native Windows harness can spawn a shebang shim or a
 * `.cmd` without a shell, so Windows registrations run `node.exe <resinHome>\bin\resin.mjs`.
 */
export function expectedMcpLaunch(
  resinHome,
  platform = process.platform,
  nodePath = process.execPath,
) {
  if (platform !== "win32") {
    return { command: path.posix.join(resinHome, "bin", "resin"), args: ["mcp"] };
  }
  return { command: nodePath, args: [path.win32.join(resinHome, "bin", "resin.mjs"), "mcp"] };
}

/** Windows paths compare case-insensitively; POSIX paths exactly. */
function samePath(a, b, platform) {
  return platform === "win32" ? String(a).toLowerCase() === String(b).toLowerCase() : a === b;
}

/** Does a JSON `mcpServers` entry launch `expected` (every expected arg present, in order)? */
export function jsonLaunchMatches(server, expected, platform = process.platform) {
  if (!server || !samePath(server.command, expected.command, platform)) return false;
  if (!Array.isArray(server.args)) return false;
  let from = 0;
  for (const arg of expected.args) {
    const index = server.args.findIndex(
      (candidate, position) => position >= from && samePath(candidate, arg, platform),
    );
    if (index < 0) return false;
    from = index + 1;
  }
  return true;
}

/** True when a TOML document holds `value` as a basic ("…") or literal ('…') string. */
function tomlHasString(toml, value) {
  return toml.includes(JSON.stringify(value)) || toml.includes(`'${value}'`);
}

/** True when a TOML document sets `command` to `command` as a basic or literal string. */
export function tomlDeclaresCommand(toml, command) {
  return (
    toml.includes(`command = ${JSON.stringify(command)}`) || toml.includes(`command = '${command}'`)
  );
}

/** Does a Codex TOML config launch `expected`? */
export function tomlLaunchMatches(toml, expected) {
  return (
    tomlDeclaresCommand(toml, expected.command) &&
    expected.args.every((arg) => tomlHasString(toml, arg))
  );
}

export async function qualifyCleanHome(installedRoot, sandboxDir, manifest) {
  const cleanHome = path.join(sandboxDir, "clean-home");
  const cleanWorkspace = path.join(sandboxDir, "clean-workspace");
  const resinHome = path.join(cleanHome, ".resin");
  fs.mkdirSync(cleanHome, { recursive: true });
  fs.mkdirSync(cleanWorkspace, { recursive: true });

  const receivedObservationBatches = [];
  const receivedTrajectoryBatches = [];

  const mockServer = http.createServer((req, res) => {
    let rawBody = "";
    req.on("data", (chunk) => {
      rawBody += chunk.toString("utf8");
    });
    req.on("end", () => {
      let body = {};
      try {
        body = JSON.parse(rawBody);
      } catch {}

      if (req.method === "POST" && req.url.startsWith("/v1/observations/batch")) {
        receivedObservationBatches.push({ body, headers: req.headers });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            batchId: body.batchId || "batch-qual-1",
            status: "accepted",
            acceptedCount: Array.isArray(body.observations) ? body.observations.length : 1,
            rejectedCount: 0,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/analytics/trajectories/batch")) {
        receivedTrajectoryBatches.push({ body, headers: req.headers });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            batchId: body.batchId || "batch-qual-1",
            status: "accepted",
            acceptedCount: Array.isArray(body.observations) ? body.observations.length : 1,
            rejectedCount: 0,
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url.startsWith("/v1/telemetry/batch")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            batchId: "batch-qual-telemetry",
            status: "accepted",
            acceptedEvents: 1,
            rejectedEvents: 0,
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/api/user/privacy")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            privacy: {
              metadataTelemetryEnabled: true,
              updatedAt: "2020-01-01T00:00:00.000Z",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", authenticated: true }));
    });
  });

  await new Promise((resolve, reject) => {
    mockServer.once("error", reject);
    mockServer.listen(0, "127.0.0.1", () => resolve());
  });
  const serverPort = mockServer.address().port;
  const cloudUrl = `http://127.0.0.1:${serverPort}`;

  const cleanEnv = {
    ...process.env,
    HOME: cleanHome,
    USERPROFILE: cleanHome,
    RESIN_HOME: resinHome,
    NODE_ENV: "production",
    RESIN_CLOUD_URL: cloudUrl,
    RESIN_CLOUD_SYNC_ENABLED: "true",
    RESIN_TELEMETRY_ENABLED: "true",
    RESIN_LOG_LEVEL: "info",
  };
  delete cleanEnv.RESIN_RELEASE_MODE;
  delete cleanEnv.RESIN_LOCAL_SOURCE_ROOT;
  delete cleanEnv.VITEST;
  delete cleanEnv.NODE_PATH;
  delete cleanEnv.CLAUDE_CONFIG_DIR;
  delete cleanEnv.CODEX_CONFIG_PATH;
  delete cleanEnv.CODEX_HOME;
  delete cleanEnv.OMP_HOME;
  delete cleanEnv.RESIN_OMP_HOME;
  if (process.platform === "win32") {
    // Windows harnesses and Resin resolve per-user state from the profile folders too.
    cleanEnv.APPDATA = path.join(cleanHome, "AppData", "Roaming");
    cleanEnv.LOCALAPPDATA = path.join(cleanHome, "AppData", "Local");
    fs.mkdirSync(cleanEnv.APPDATA, { recursive: true });
    fs.mkdirSync(cleanEnv.LOCALAPPDATA, { recursive: true });
  }

  let daemonChild = null;

  try {
    const initCli = createQualificationCliDriver(installedRoot, sandboxDir);
    const initResult = runNode(
      initCli,
      [
        "init",
        "--non-interactive",
        "--auto-approve",
        "--local-only",
        "--harness=omp,codex-cli",
        `--home=${cleanHome}`,
        `--workspace=${cleanWorkspace}`,
        "--json",
      ],
      { cwd: cleanWorkspace, env: cleanEnv, timeoutMs: 30_000 },
    );
    if (initResult.status !== 0) {
      throw new Error(
        `Packaged CLI init in clean home failed: ${initResult.stderr || initResult.stdout}`,
      );
    }

    // Invariant 1: Installed config has telemetryEnabled true
    const daemonConfigFile = path.join(resinHome, "config", "config.json");
    if (!fs.existsSync(daemonConfigFile)) {
      throw new Error(`Expected daemon config file at ${daemonConfigFile}, but it was not created`);
    }
    const daemonConfig = JSON.parse(fs.readFileSync(daemonConfigFile, "utf8"));
    if (daemonConfig.telemetryEnabled !== true) {
      throw new Error(
        `Expected installed daemon config to have telemetryEnabled: true, got: ${daemonConfig.telemetryEnabled}`,
      );
    }

    // Invariant 2: No auth.token/daemon.token is generated
    const forbiddenTokenPaths = [
      path.join(cleanHome, "auth.token"),
      path.join(cleanHome, "daemon.token"),
      path.join(resinHome, "auth.token"),
      path.join(resinHome, "daemon.token"),
      path.join(resinHome, "state", "auth.token"),
      path.join(resinHome, "state", "daemon.token"),
      path.join(resinHome, "config", "auth.token"),
      path.join(resinHome, "config", "daemon.token"),
    ];
    for (const tokenPath of forbiddenTokenPaths) {
      if (fs.existsSync(tokenPath)) {
        throw new Error(`Found unexpected legacy token file at: ${tokenPath}`);
      }
    }

    // Invariant 4: Generated OMP and Codex configs each contain one canonical stdio resin entry and no legacy localhost SSE
    const expectedLaunch = expectedMcpLaunch(resinHome);
    const expectedMcpCommand = [expectedLaunch.command, ...expectedLaunch.args].join(" ");
    const ompConfigCandidates = [
      path.join(cleanWorkspace, ".omp", "agent", "mcp.json"),
      path.join(cleanWorkspace, ".omp", "mcp.json"),
      path.join(cleanHome, ".omp", "agent", "mcp.json"),
      path.join(cleanHome, ".omp", "mcp.json"),
    ];
    const ompConfigFile = ompConfigCandidates.find((candidate) => fs.existsSync(candidate));
    if (!ompConfigFile) {
      throw new Error(
        `No OMP MCP configuration found in candidate locations: ${ompConfigCandidates.join(", ")}`,
      );
    }
    const ompConfigRaw = fs.readFileSync(ompConfigFile, "utf8");
    const ompConfig = JSON.parse(ompConfigRaw);
    const ompServer = ompConfig.mcpServers?.resin ?? ompConfig.mcpServers?.["resin-gateway"];
    if (!ompServer) {
      throw new Error(
        `OMP config at ${ompConfigFile} missing 'resin' mcpServers entry: ${ompConfigRaw}`,
      );
    }
    if (!jsonLaunchMatches(ompServer, expectedLaunch)) {
      throw new Error(
        `OMP mcpServers entry does not launch the installed '${expectedMcpCommand}': ${JSON.stringify(ompServer)}`,
      );
    }
    if (
      ompServer.type === "sse" ||
      ompServer.url ||
      ompConfigRaw.includes("localhost:9400") ||
      ompConfigRaw.includes("127.0.0.1:9400") ||
      ompConfigRaw.includes("/mcp/sse") ||
      ompConfigRaw.includes("resin-mcp")
    ) {
      throw new Error(
        `OMP config at ${ompConfigFile} leaked legacy localhost SSE or resin-mcp configuration: ${ompConfigRaw}`,
      );
    }

    const codexConfigCandidates = [
      path.join(cleanWorkspace, ".codex", "config.toml"),
      path.join(cleanHome, ".codex", "config.toml"),
    ];
    const codexConfigFile = codexConfigCandidates.find((candidate) => fs.existsSync(candidate));
    if (!codexConfigFile) {
      throw new Error(
        `No Codex configuration found in candidate locations: ${codexConfigCandidates.join(", ")}`,
      );
    }
    const codexConfigRaw = fs.readFileSync(codexConfigFile, "utf8");
    if (
      !codexConfigRaw.includes("[mcp_servers.resin]") &&
      !codexConfigRaw.includes("[mcp_servers.resin-gateway]")
    ) {
      throw new Error(
        `Codex config at ${codexConfigFile} missing [mcp_servers.resin] section: ${codexConfigRaw}`,
      );
    }
    if (!tomlLaunchMatches(codexConfigRaw, expectedLaunch)) {
      throw new Error(
        `Codex config at ${codexConfigFile} does not launch the installed '${expectedMcpCommand}': ${codexConfigRaw}`,
      );
    }
    if (
      codexConfigRaw.includes("localhost:9400") ||
      codexConfigRaw.includes("127.0.0.1:9400") ||
      codexConfigRaw.includes("/mcp/sse") ||
      codexConfigRaw.includes("resin-mcp")
    ) {
      throw new Error(
        `Codex config at ${codexConfigFile} leaked legacy localhost SSE or resin-mcp configuration: ${codexConfigRaw}`,
      );
    }

    // Set up mock cloud device credentials and OMP fixture
    const stateDir = path.join(resinHome, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    const deviceTokenPayload = {
      cloudUrl,
      accessToken: "test-qualification-token",
      claims: {
        accountId: "acc_qual_clean",
        workspaceId: "ws_clean_home_1",
        deviceId: "dev_clean_home_1",
        installationId: "inst_clean_home_1",
        userId: "usr_clean_home_1",
        actorType: "user",
        tokenType: "access",
        rawUploadConsent: false,
        scopes: ["device:connect", "observations:write"],
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
      deviceId: "dev_clean_home_1",
      workspaceId: "ws_clean_home_1",
      storedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stateDir, "device-token.json"),
      JSON.stringify(deviceTokenPayload, null, 2),
      { mode: 0o600 },
    );

    const ompSessionsDir = path.join(cleanHome, ".omp", "sessions");
    const ompAgentSessionsDir = path.join(cleanHome, ".omp", "agent", "sessions");
    const ompBreadcrumbsDir = path.join(cleanHome, ".omp", "breadcrumbs");
    const workspaceOmpSessionsDir = path.join(cleanWorkspace, ".omp", "sessions");
    fs.mkdirSync(ompSessionsDir, { recursive: true });
    fs.mkdirSync(ompAgentSessionsDir, { recursive: true });
    fs.mkdirSync(ompBreadcrumbsDir, { recursive: true });
    fs.mkdirSync(workspaceOmpSessionsDir, { recursive: true });

    const workspaceTranscriptPath = path.join(
      workspaceOmpSessionsDir,
      "session-clean-qual-1.jsonl",
    );
    fs.writeFileSync(path.join(ompSessionsDir, "session-clean-qual-1.jsonl"), "", "utf8");
    fs.writeFileSync(path.join(ompAgentSessionsDir, "session-clean-qual-1.jsonl"), "", "utf8");
    fs.writeFileSync(workspaceTranscriptPath, "", "utf8");
    fs.writeFileSync(
      path.join(ompBreadcrumbsDir, "session-clean-qual-1.json"),
      JSON.stringify(
        {
          sessionId: "session-clean-qual-1",
          workspaceId: "ws_clean_home_1",
          workspacePath: cleanWorkspace,
          metadata: { harness: "omp" },
        },
        null,
        2,
      ),
      "utf8",
    );

    // Invariant 3: Daemon readiness works through the local endpoint (Unix socket on POSIX,
    // owner-only named pipe on Windows).
    const daemonBin = path.join(installedRoot, "bin", "resin-daemon");
    const socketPath = path.join(stateDir, "daemon.sock");
    const endpoint = daemonEndpointArgs(socketPath);
    daemonChild = spawn(
      process.execPath,
      [daemonBin, "--foreground", "--home", cleanHome, ...endpoint],
      {
        cwd: cleanWorkspace,
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    daemonChild.stdout.resume();
    daemonChild.stderr.resume();

    const statusResult = await waitFor(
      () => {
        const res = runNode(daemonBin, ["--status", "--home", cleanHome, ...endpoint], {
          cwd: cleanWorkspace,
          env: cleanEnv,
          timeoutMs: 3000,
        });
        return res.status === 0 ? res : false;
      },
      { timeoutMs: 15_000, intervalMs: 200 },
    );
    if (!statusResult) {
      throw new Error(
        `Packaged daemon in clean home did not respond over its local endpoint (${endpoint.length > 0 ? socketPath : "named pipe"})`,
      );
    }

    const diagResult = runNode(daemonBin, ["--diagnostics", "--home", cleanHome, ...endpoint], {
      cwd: cleanWorkspace,
      env: cleanEnv,
      timeoutMs: 5000,
    });
    if (diagResult.status !== 0) {
      throw new Error(
        `Packaged daemon diagnostics failed: ${diagResult.stderr || diagResult.stdout}`,
      );
    }
    const windowsIsolation =
      process.platform === "win32"
        ? await verifyWindowsDaemonIsolation(installedRoot, resinHome)
        : undefined;
    fs.appendFileSync(workspaceTranscriptPath, OMP_QUALIFICATION_FIXTURE_LINES, "utf8");

    // Invariant 5: the packaged capture runtime normalizes OMP JSONL into SQLite and
    // receives an acknowledgment from the existing mock-cloud batch endpoint.
    const stateDbPath = path.join(resinHome, "data", "qualification-state.db");
    // Runs with the clean home's environment: the capture runtime keeps its private values
    // (redaction key) under the user's Resin home, which must be the sandbox, not the real one.
    await ingestPackagedOmpFixture(
      {
        installedRoot,
        stateDbPath,
        transcriptPath: workspaceTranscriptPath,
        cloudUrl,
      },
      { env: cleanEnv },
    );
    if (receivedObservationBatches.length === 0 && receivedTrajectoryBatches.length === 0) {
      throw new Error("Packaged OMP capture did not reach the mock-cloud batch endpoint");
    }
    if (!fs.existsSync(stateDbPath)) {
      throw new Error(`Expected SQLite state database at ${stateDbPath}, but it was not created`);
    }
    const dbStat = fs.statSync(stateDbPath);
    if (dbStat.size === 0) {
      throw new Error(`SQLite state database at ${stateDbPath} is empty`);
    }

    const stopResult = runNode(daemonBin, ["--stop", "--home", cleanHome, ...endpoint], {
      cwd: cleanWorkspace,
      env: cleanEnv,
      timeoutMs: 5000,
    });
    if (stopResult.status !== 0) {
      throw new Error(
        `Packaged daemon stop command failed: ${stopResult.stderr || stopResult.stdout}`,
      );
    }
    const exitCode = await waitForExit(daemonChild, 7000);
    if (exitCode === null) {
      throw new Error("Packaged daemon did not exit after authenticated stop command");
    }

    return {
      telemetryEnabled: true,
      noLegacyTokens: true,
      daemonSocketReadiness: true,
      canonicalHarnessConfigs: true,
      ompBatchAcknowledged: true,
      sqliteStored: true,
      ...(windowsIsolation ? { windowsIsolation } : {}),
    };
  } finally {
    if (daemonChild) {
      terminateProcess(daemonChild);
    }
    try {
      mockServer.close();
    } catch {}
  }
}

export const DEFAULT_WINDOWS_TASK_NAME = "\\Resin\\ResinDaemon";

/** Split `\Folder\Name` into Get-ScheduledTask's `-TaskPath '\Folder\'` and `-TaskName`. */
export function splitScheduledTaskName(fullName) {
  const normalized = fullName.startsWith("\\") ? fullName : `\\${fullName}`;
  const index = normalized.lastIndexOf("\\");
  return { taskPath: normalized.slice(0, index + 1), taskName: normalized.slice(index + 1) };
}

/** Read the per-user Scheduled Task through Windows PowerShell 5.1's ScheduledTasks module. */
function queryScheduledTask(fullName, env) {
  const { taskPath, taskName } = splitScheduledTaskName(fullName);
  const script = [
    `$task = Get-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -ErrorAction SilentlyContinue`,
    "if ($null -eq $task) { 'null'; exit 0 }",
    "[pscustomobject]@{",
    "  state = [string]$task.State",
    "  userId = [string]$task.Principal.UserId",
    "  logonType = [string]$task.Principal.LogonType",
    "  runLevel = [string]$task.Principal.RunLevel",
    "  triggers = @($task.Triggers | ForEach-Object { [string]$_.CimClass.CimClassName })",
    "  executionTimeLimit = [string]$task.Settings.ExecutionTimeLimit",
    "  actions = @($task.Actions | ForEach-Object { [string]$_.Execute })",
    "} | ConvertTo-Json -Compress -Depth 4",
  ].join("\n");
  const result = runPowerShell(script, { env });
  if (result.status !== 0) {
    throw new Error(`Get-ScheduledTask ${fullName} failed: ${result.stderr || result.error}`);
  }
  return JSON.parse(result.stdout.trim() || "null");
}

function unregisterScheduledTask(fullName, env) {
  const { taskPath, taskName } = splitScheduledTaskName(fullName);
  runPowerShell(
    `Unregister-ScheduledTask -TaskPath ${psQuote(taskPath)} -TaskName ${psQuote(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
    { env },
  );
}

function parseJsonOutput(result, label) {
  const text = result.stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error(`${label} printed no JSON: ${result.stderr || text}`);
  }
  return JSON.parse(text.slice(start));
}

function readDaemonPid(resinHome) {
  try {
    const pid = Number.parseInt(
      fs.readFileSync(path.join(resinHome, "state", "daemon.pid"), "utf8").trim(),
      10,
    );
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Native Windows service lifecycle, run against a Resin home that install.ps1 installed
 * (the Scheduled Task launches the installed `bin\resin-daemon.mjs`, which an extracted
 * artifact does not have): `resin init` registers the per-user logon Scheduled Task and
 * starts it; the daemon answers on its owner-only pipe; a killed daemon is respawned by the
 * supervisor; `resin service stop|start` toggle it. The service is left running so the caller
 * can probe it and then prove `resin uninstall` removes it. Refuses to touch a task that
 * already exists.
 */
export async function qualifyWindowsService(options) {
  const resinHome = path.resolve(options.resinHome);
  const userHome = path.resolve(
    options.userHome ??
      (path.basename(resinHome) === ".resin" ? path.dirname(resinHome) : os.homedir()),
  );
  const installedRoot = path.join(resinHome, "current");
  const taskName =
    options.taskName ?? process.env.RESIN_WINDOWS_TASK_NAME ?? DEFAULT_WINDOWS_TASK_NAME;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-windows-service-"));
  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    RESIN_HOME: resinHome,
    RESIN_WINDOWS_TASK_NAME: taskName,
    NODE_ENV: "production",
    RESIN_CLOUD_SYNC_ENABLED: "false",
    RESIN_TELEMETRY_ENABLED: "false",
  };
  delete env.NODE_PATH;
  delete env.VITEST;
  delete env.RESIN_RELEASE_MODE;
  delete env.RESIN_LOCAL_SOURCE_ROOT;

  if (!fs.existsSync(path.join(installedRoot, "apps", "cli", "dist", "index.js"))) {
    throw new Error(`No installed Resin release at ${installedRoot}; run install.ps1 first`);
  }
  if (queryScheduledTask(taskName, env) !== null) {
    throw new Error(
      `Scheduled Task ${taskName} already exists; refusing to replace it (set RESIN_WINDOWS_TASK_NAME to a test task name)`,
    );
  }

  const cli = path.join(installedRoot, "bin", "resin");
  const run = (args, timeoutMs = 30_000) =>
    runNode(cli, [...args], { cwd: workDir, env, timeoutMs });
  const status = () =>
    parseJsonOutput(run(["status", "--json", "--home", userHome]), "resin status");
  const healthy = (summary) =>
    summary.service?.installed === true &&
    summary.service?.active === true &&
    summary.ipc?.responsive === true;

  try {
    // The candidate is test-signed, which production-mode init rejects; local-test release
    // mode runs the same init with service setup against the installed release.
    const initCli = createQualificationCliDriver(installedRoot, workDir, { service: true });
    const init = runNode(
      initCli,
      [
        "init",
        "--non-interactive",
        "--auto-approve",
        "--local-only",
        `--home=${userHome}`,
        `--workspace=${workDir}`,
        "--json",
      ],
      { cwd: workDir, env, timeoutMs: 120_000 },
    );
    if (init.status !== 0) {
      throw new Error(
        `resin init with service setup failed (exit ${init.status}): ${init.stdout}\n${init.stderr}`,
      );
    }

    const task = queryScheduledTask(taskName, env);
    if (!task) throw new Error(`resin init did not register Scheduled Task ${taskName}`);
    const username = os.userInfo().username.toLowerCase();
    const taskProblems = [
      !task.userId.toLowerCase().endsWith(username) && `runs as ${task.userId}, not ${username}`,
      task.logonType !== "Interactive" && `logon type ${task.logonType} (expected Interactive)`,
      task.runLevel !== "Limited" && `run level ${task.runLevel} (expected Limited)`,
      !task.triggers.includes("MSFT_TaskLogonTrigger") &&
        `triggers ${task.triggers.join(",")} lack a logon trigger`,
      task.executionTimeLimit !== "PT0S" &&
        `execution time limit ${task.executionTimeLimit} (expected PT0S)`,
      !task.actions.some((action) => /resin-service-host\.exe$/i.test(action)) &&
        `actions ${task.actions.join(",")} do not launch resin-service-host.exe`,
    ].filter(Boolean);
    if (taskProblems.length > 0) {
      throw new Error(`Scheduled Task ${taskName} is misconfigured: ${taskProblems.join("; ")}`);
    }

    const started = await waitFor(
      () => {
        const summary = status();
        return healthy(summary) ? summary : false;
      },
      { timeoutMs: 60_000, intervalMs: 500 },
    );
    if (started.service.platform !== "windows-task") {
      throw new Error(`resin status reports service platform ${started.service.platform}`);
    }
    // A local-only install has no cloud consent for the default-on metadata telemetry, which
    // `resin status` counts as degraded on every platform; turn it off (the daemon reloads over
    // IPC), then require an overall healthy status before the deliberate crash below, whose
    // recovery record keeps the status degraded for the crash window.
    const privacy = run(["privacy", "telemetry", "disable", "--json", "--home", userHome]);
    if (privacy.status !== 0) {
      throw new Error(
        `resin privacy telemetry disable failed: ${privacy.stderr || privacy.stdout}`,
      );
    }
    await waitFor(() => status().status === "healthy", { timeoutMs: 60_000, intervalMs: 1000 });
    const isolation = await verifyWindowsDaemonIsolation(installedRoot, resinHome);

    // Crash: kill the daemon process outright; the supervisor must bring a new one up.
    const crashedPid = await waitFor(() => readDaemonPid(resinHome), { timeoutMs: 15_000 });
    const kill = runPowerShell(`Stop-Process -Id ${crashedPid} -Force -ErrorAction Stop`, { env });
    if (kill.status !== 0) {
      throw new Error(`Stop-Process ${crashedPid} failed: ${kill.stderr || kill.error}`);
    }
    const restartedPid = await waitFor(
      () => {
        const pid = readDaemonPid(resinHome);
        return pid && pid !== crashedPid && processAlive(pid) && healthy(status()) ? pid : false;
      },
      { timeoutMs: 90_000, intervalMs: 1000 },
    );

    const stop = run(["service", "stop", "--json", "--home", userHome]);
    if (stop.status !== 0) {
      throw new Error(`resin service stop failed: ${stop.stderr || stop.stdout}`);
    }
    await waitFor(
      () => {
        const summary = status();
        return summary.service?.active === false && summary.ipc?.responsive !== true;
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );
    const start = run(["service", "start", "--json", "--home", userHome]);
    if (start.status !== 0) {
      throw new Error(`resin service start failed: ${start.stderr || start.stdout}`);
    }
    await waitFor(() => healthy(status()), { timeoutMs: 60_000, intervalMs: 500 });

    return {
      backend: "windows-task",
      taskName,
      taskRegistered: true,
      logonTrigger: true,
      leastPrivilege: true,
      noExecutionTimeLimit: true,
      started: true,
      statusHealthy: true,
      pipeIsolation: isolation,
      crashRestart: true,
      crashedPid,
      restartedPid,
      stopStart: true,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/**
 * Add the installed-product service lifecycle to a Windows lane's native evidence. The lane
 * evidence must already have passed, and the installed release must be the qualified one.
 */
export async function recordWindowsServiceQualification(lane, options) {
  const outputDir = path.resolve(options.outputDir);
  const evidencePath = path.join(outputDir, `${lane}.json`);
  const write = (evidence) => {
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    return evidence;
  };
  if (!isWindowsLane(lane)) {
    throw new Error(`--windows-service applies to windows lanes only, not '${lane}'`);
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (evidence.passed !== true || evidence.status !== "QUALIFIED") {
    throw new Error(`${lane} evidence at ${evidencePath} is ${evidence.status}; qualify it first`);
  }
  try {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(path.resolve(options.resinHome), "current", "platform.json"),
        "utf8",
      ),
    );
    const qualified = evidence.release?.platformMetadata ?? {};
    if (
      installed.releaseVersion !== qualified.releaseVersion ||
      installed.platform !== qualified.platform ||
      installed.arch !== qualified.arch
    ) {
      throw new Error(
        `Installed release ${JSON.stringify(installed)} is not the qualified artifact ${JSON.stringify(qualified)}`,
      );
    }
    const windowsService = await qualifyWindowsService(options);
    return write({
      ...evidence,
      endedAt: new Date().toISOString(),
      checks: { ...evidence.checks, windowsService },
    });
  } catch (error) {
    return write({
      ...evidence,
      endedAt: new Date().toISOString(),
      status: "FAILED",
      passed: false,
      error: `Windows service lifecycle: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Steps that import code from the packaged artifact. They never run in the qualification
 * process: on Windows a loaded `.node` addon (and any module that pulls it in) stays mapped
 * until its process exits, and a mapped image cannot be deleted, so sandbox cleanup (and
 * `resin uninstall` of an installed home) would fail. Each step runs in a child process that
 * exits before anything is removed.
 */
const PACKAGED_TASKS = Object.freeze({
  "verify-windows-isolation": (args) => verifyWindowsDaemonIsolationInProcess(args),
  "ingest-omp-fixture": (args) => ingestPackagedOmpFixtureInProcess(args),
  "probe-harnesses": (args) => probeHarnessesInProcess(args),
});

const CHILD_RESULT_MARKER = "@@RESIN_PACKAGED_TASK_RESULT@@";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

/**
 * Run a PACKAGED_TASKS step in a child node process and resolve with its result. Async on
 * purpose: steps such as the OMP ingest talk to this process's mock cloud server.
 */
export function runPackagedTask(task, args, options = {}) {
  if (!(task in PACKAGED_TASKS)) throw new Error(`Unknown packaged task '${task}'`);
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SCRIPT_PATH, "--packaged-task", task, "--packaged-task-args", JSON.stringify(args)],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((entry) => entry.startsWith(CHILD_RESULT_MARKER));
      if (!line) {
        reject(
          new Error(`Packaged task ${task} exited ${code} without a result: ${stderr || stdout}`),
        );
        return;
      }
      const outcome = JSON.parse(line.slice(CHILD_RESULT_MARKER.length));
      if (outcome.ok) resolve(outcome.value);
      else reject(new Error(outcome.error));
    });
  });
}

async function runPackagedTaskInThisProcess(task, rawArgs) {
  let outcome;
  try {
    outcome = { ok: true, value: (await PACKAGED_TASKS[task](JSON.parse(rawArgs))) ?? null };
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`\n${CHILD_RESULT_MARKER}${JSON.stringify(outcome)}\n`);
  return outcome.ok;
}

function verifyWindowsDaemonIsolation(installedRoot, resinHome) {
  return runPackagedTask("verify-windows-isolation", { installedRoot, resinHome });
}

function ingestPackagedOmpFixture(args, options = {}) {
  return runPackagedTask("ingest-omp-fixture", args, options);
}

function probeHarnesses(installedRoot, env) {
  return runPackagedTask("probe-harnesses", { installedRoot }, { env });
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || Object.prototype.toString.call(address) === "[object String]") {
        server.close();
        reject(new Error("Could not reserve a cloud qualification port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function probeHarnessesInProcess({ installedRoot }) {
  const registryModule = path.join(installedRoot, "apps", "cli", "dist", "harness-registry.js");
  const contractsModule = path.join(
    installedRoot,
    "packages",
    "harness-contracts",
    "dist",
    "index.js",
  );
  for (const module of [registryModule, contractsModule]) {
    if (!fs.existsSync(module)) {
      return Object.keys(V1_SUPPORT_MATRIX.harnesses).map((harnessId) => ({
        harnessId,
        status: "unavailable",
        qualified: false,
        reason: `module_not_found: ${module}`,
      }));
    }
  }
  const { HARNESS_DEFINITIONS } = await import(pathToFileURL(registryModule).href);
  const { classifyHarnessVersion, defaultFsBridge } = await import(
    pathToFileURL(contractsModule).href
  );
  const home = os.homedir();
  const env = process.env;
  const results = [];
  for (const definition of HARNESS_DEFINITIONS) {
    try {
      const installation = await definition.probeInstallation({
        targetPath: definition.mcpConfig.resolvePath(home, env),
        home,
        env,
        fsBridge: defaultFsBridge,
      });
      if (!installation) {
        results.push({
          harnessId: definition.id,
          status: "unavailable",
          qualified: false,
          reason: "not_detected",
        });
        continue;
      }
      const qualified = installation.status === "ready" && installation.isInstalled === true;
      const version = installation.version ?? null;
      results.push({
        harnessId: definition.id,
        status: qualified ? "ready" : "unavailable",
        qualified,
        detectedStatus: installation.status,
        version,
        versionStatus: classifyHarnessVersion(version ?? undefined, definition.testedVersions),
        executablePath: installation.executablePath ?? null,
        reason: qualified ? "qualified" : `status_${installation.status}`,
      });
    } catch (error) {
      results.push({
        harnessId: definition.id,
        status: "unavailable",
        qualified: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export async function qualifyPlatformLane(lane, options = {}) {
  const startedAt = new Date().toISOString();
  const host = hostEnvironment();
  const releaseDir = path.resolve(options.releaseDir ?? `dist/release/v1.0.0`);
  const outputDir = path.resolve(options.outputDir ?? path.join(releaseDir, "qualification"));
  const mode = options.mode ?? "native";
  const isNativeExecution = host.lane === lane;
  const baseEvidence = {
    schemaVersion: "2.0.0",
    lane,
    host,
    execution: {
      mode,
      native: mode === "native" && isNativeExecution,
      runtimeExercised: false,
      hostMatchesLane: isNativeExecution,
      requestedLane: lane,
      executingLane: host.lane,
    },
    startedAt,
    endedAt: null,
    status: "UNAVAILABLE",
    passed: false,
    supportMatrix: V1_SUPPORT_MATRIX,
    release: null,
    checks: {},
    harnesses: [],
    error: null,
  };

  if (!REQUIRED_QUALIFICATION_LANES.includes(lane)) {
    return {
      ...baseEvidence,
      endedAt: new Date().toISOString(),
      error: `Unknown qualification lane '${lane}'`,
    };
  }
  if (mode !== "native" && mode !== "artifact") {
    return {
      ...baseEvidence,
      endedAt: new Date().toISOString(),
      error: `Unknown qualification mode '${mode}'`,
    };
  }
  if (!isNativeExecution && mode === "native") {
    return {
      ...baseEvidence,
      endedAt: new Date().toISOString(),
      error: `Host mismatch: requested ${lane}, executing on ${host.lane ?? "unsupported-host"}`,
    };
  }
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), `resin-${lane}-qualification-`));

  try {
    const manifest = readManifest(releaseDir);
    const resolved = resolveAsset(releaseDir, lane, manifest);
    const installedRoot = extractRelease(resolved.archivePath, path.join(sandboxDir, "extracted"));
    const platformMetadata = validatePlatformMetadata(installedRoot, lane, manifest);
    const artifactLayout = validateArtifactLayout(installedRoot, lane);
    let status = "ARTIFACT_VALIDATED";
    let checks = {
      artifactDigest: true,
      platformMetadata: true,
      artifactLayout,
    };
    let harnesses = [];
    if (mode === "native") {
      baseEvidence.execution.runtimeExercised = true;
      const windows = isWindowsLane(lane);
      let windowsHost;
      if (windows) {
        requireRealNativePrebuilds(artifactLayout, lane.slice("windows-".length));
        windowsHost = probeWindowsShells();
      }
      const cli = qualifyCli(installedRoot, sandboxDir, manifest);
      const windowsLaunchers = windows
        ? qualifyWindowsLaunchers(installedRoot, sandboxDir, manifest, windowsHost)
        : undefined;
      const daemon = await qualifyDaemon(installedRoot, sandboxDir);
      const mcp = await qualifyMcp(installedRoot, sandboxDir);
      const cleanHome = await qualifyCleanHome(installedRoot, sandboxDir, manifest);
      harnesses = await probeHarnesses(installedRoot);
      status = "QUALIFIED";
      checks = {
        ...checks,
        packagedCli: cli,
        daemon,
        mcp,
        cleanHome,
        ...(windows ? { windowsHost, windowsLaunchers } : {}),
      };
    }

    const evidence = {
      ...baseEvidence,
      endedAt: new Date().toISOString(),
      status,
      passed: true,
      release: {
        version: manifest.version,
        commitSha: manifest.releaseIdentity?.commitSha ?? null,
        manifestSha256: sha256File(path.join(releaseDir, "manifest.json")),
        assetId: resolved.assetId,
        assetFilename: resolved.asset.filename,
        assetSha256: resolved.actualDigest,
        platformMetadata,
      },
      checks,
      harnesses,
      error: null,
    };
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, `${lane}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    return evidence;
  } catch (error) {
    const evidence = {
      ...baseEvidence,
      endedAt: new Date().toISOString(),
      status: "FAILED",
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    };
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, `${lane}.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    return evidence;
  } finally {
    if (process.env.RESIN_QUALIFICATION_KEEP_SANDBOX === "1") {
      process.stderr.write(`Keeping qualification sandbox ${sandboxDir}\n`);
    } else {
      // Windows may still hold handles from just-exited daemon processes for a moment.
      fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

/**
 * What a qualification run on this host would do, without extracting or running anything.
 * `node scripts/platform-qualification.mjs --detect` prints it.
 */
export function describeQualificationPlan(options = {}) {
  const host = hostEnvironment();
  const lane = options.lane ?? host.lane;
  const mode = options.mode ?? "native";
  const windows = lane !== null && isWindowsLane(lane);
  const native = mode === "native" && lane !== null && lane === host.lane;
  const plannedChecks = ["artifactDigest", "platformMetadata", "artifactLayout"];
  if (native) {
    if (windows) plannedChecks.push("windowsHost", "nativePrebuilds", "windowsLaunchers");
    plannedChecks.push("packagedCli", "daemon", "mcp", "cleanHome");
  }
  return {
    schemaVersion: "2.0.0",
    host,
    lane,
    supported: lane !== null && REQUIRED_QUALIFICATION_LANES.includes(lane),
    mode,
    native,
    daemonEndpoint: windows ? "named-pipe" : "unix-socket",
    requiredArtifactFiles: lane ? [...requiredArtifactFiles(lane)] : [],
    windowsShells: process.platform === "win32" ? probeWindowsShells() : null,
    // After install.ps1: `--windows-service --resin-home=<home>` adds checks.windowsService.
    followUpChecks: windows ? ["windowsService"] : [],
    windowsTaskName: windows
      ? (options.windowsTaskName ??
        process.env.RESIN_WINDOWS_TASK_NAME ??
        DEFAULT_WINDOWS_TASK_NAME)
      : null,
    plannedChecks,
  };
}

export async function runPlatformQualification(options = {}) {
  const lane = options.lane ?? detectHostLane();
  if (!lane) {
    return {
      schemaVersion: "2.0.0",
      status: "UNAVAILABLE",
      passed: false,
      host: hostEnvironment(),
      lanes: [],
      error: "Current host is not a supported release qualification lane",
    };
  }
  const result = await qualifyPlatformLane(lane, options);
  return {
    schemaVersion: "2.0.0",
    status: result.status,
    passed: result.passed,
    host: result.host,
    totalLanes: 1,
    passedLanes: result.passed ? 1 : 0,
    lanes: [result],
    error: result.error,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--emit-matrix" || arg === "--matrix") {
      options.emitMatrix = true;
    } else if (arg === "--lane") options.lane = argv[++index];
    else if (arg.startsWith("--lane=")) options.lane = arg.slice("--lane=".length);
    else if (arg === "--release-dir") options.releaseDir = argv[++index];
    else if (arg.startsWith("--release-dir=")) {
      options.releaseDir = arg.slice("--release-dir=".length);
    } else if (arg === "--output-dir") options.outputDir = argv[++index];
    else if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
    } else if (arg === "--mode") options.mode = argv[++index];
    else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--packaged-task") options.packagedTask = argv[++index];
    else if (arg === "--packaged-task-args") options.packagedTaskArgs = argv[++index];
    else if (arg === "--windows-service") options.windowsService = true;
    else if (arg.startsWith("--resin-home=")) options.resinHome = arg.slice("--resin-home=".length);
    else if (arg.startsWith("--user-home=")) options.userHome = arg.slice("--user-home=".length);
    else if (arg.startsWith("--windows-task-name=")) {
      options.windowsTaskName = arg.slice("--windows-task-name=".length);
    } else if (arg === "--detect" || arg === "--dry-run") options.detect = true;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.packagedTask) {
    const ok = await runPackagedTaskInThisProcess(parsed.packagedTask, parsed.packagedTaskArgs);
    process.exitCode = ok ? 0 : 1;
  } else if (parsed.emitMatrix) {
    process.stdout.write(`${emitSupportMatrix({ format: "json" })}\n`);
    process.exitCode = 0;
  } else if (parsed.windowsService) {
    const lane = parsed.lane ?? detectHostLane();
    const evidence = await recordWindowsServiceQualification(lane, {
      outputDir: parsed.outputDir ?? "dist/qualification",
      resinHome: parsed.resinHome ?? process.env.RESIN_HOME ?? path.join(os.homedir(), ".resin"),
      userHome: parsed.userHome,
      taskName: parsed.windowsTaskName,
    });
    process.stdout.write(
      `${JSON.stringify(evidence.checks.windowsService ?? evidence.error, null, 2)}\n`,
    );
    process.exitCode = evidence.passed ? 0 : 1;
  } else if (parsed.detect) {
    const plan = describeQualificationPlan(parsed);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.exitCode = plan.supported ? 0 : 1;
  } else {
    const result = await runPlatformQualification(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  }
}
