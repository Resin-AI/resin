#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { V1_SUPPORT_MATRIX } from "../apps/cli/dist/platform/platform.js";

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

function extractRelease(archivePath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const result = spawnSync("tar", ["-xzf", archivePath, "-C", targetDir], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to extract release artifact: ${result.stderr || result.stdout}`);
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

const REQUIRED_ARTIFACT_FILES = Object.freeze([
  "platform.json",
  "bin/resin",
  "bin/resin-daemon",
  "bin/resin-mcp",
]);

const PROPRIETARY_ARTIFACT_PATHS = Object.freeze([
  "apps/cloud",
  "apps/web",
  "packages/cloud-contracts",
]);

function validateArtifactLayout(installedRoot) {
  const missingFiles = REQUIRED_ARTIFACT_FILES.filter((relativePath) => {
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
  return {
    requiredFiles: [...REQUIRED_ARTIFACT_FILES],
    verifiedFiles: REQUIRED_ARTIFACT_FILES.length,
    proprietaryArtifactsAbsent: true,
  };
}

function qualifyCli(installedRoot, sandboxDir, manifest) {
  const cli = path.join(installedRoot, "bin", V1_SUPPORT_MATRIX.product.binaryName);
  const outside = path.join(sandboxDir, "outside-workspace");
  const dryRunHome = path.join(sandboxDir, "dry-run-home");
  const workspace = path.join(sandboxDir, "workspace");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
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
    cli,
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
  fs.mkdirSync(daemonHome, { recursive: true });
  const env = {
    ...process.env,
    NODE_ENV: "production",
    RESIN_LOG_LEVEL: "silent",
    RESIN_CLOUD_SYNC_ENABLED: "false",
    RESIN_TELEMETRY_ENABLED: "false",
  };
  delete env.NODE_PATH;

  const child = spawn(
    process.execPath,
    [daemonBin, "--foreground", "--home", daemonHome, "--socket", socketPath],
    { cwd: sandboxDir, env, stdio: ["ignore", "pipe", "pipe"] },
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
        const result = runNode(
          daemonBin,
          ["--status", "--home", daemonHome, "--socket", socketPath],
          { cwd: sandboxDir, env, timeoutMs: 3000 },
        );
        return result.status === 0 ? result : false;
      },
      { timeoutMs: 15_000, intervalMs: 200 },
    );
    const diagnostics = runNode(
      daemonBin,
      ["--diagnostics", "--home", daemonHome, "--socket", socketPath],
      { cwd: sandboxDir, env, timeoutMs: 5000 },
    );
    if (diagnostics.status !== 0) {
      throw new Error(
        `Packaged daemon diagnostics failed: ${diagnostics.stderr || diagnostics.stdout}`,
      );
    }
    const stop = runNode(daemonBin, ["--stop", "--home", daemonHome, "--socket", socketPath], {
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
  const mcpBin = path.join(installedRoot, "bin", "resin-mcp");
  const workspace = path.join(sandboxDir, "mcp-workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.NODE_PATH;
  const child = spawn(
    process.execPath,
    [mcpBin, "--standalone", "--cwd", workspace, "--harness", "qualification"],
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
    const expectedMetaTools = ["search_tools", "get_tool_schema", "invoke_tool", "manage_tools"];
    for (const metaTool of expectedMetaTools) {
      if (!toolNames.includes(metaTool)) {
        throw new Error(
          `MCP catalog did not include essential system meta-tool ${metaTool}: ${JSON.stringify(toolNames)}`,
        );
      }
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
      arguments: { toolId: "sys_search_tools" },
    });
    if (called.error) throw new Error(`MCP tools/call failed: ${JSON.stringify(called)}`);
    const rendered = JSON.stringify(called.result ?? {});
    if (!rendered.includes("search_tools")) {
      throw new Error(`MCP get_tool_schema invocation returned unexpected result: ${rendered}`);
    }
    return {
      initialized: true,
      catalogRefresh: true,
      toolCount: toolNames.length,
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

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a cloud qualification port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function probeHarnesses(installedRoot) {
  const probes = Object.values(V1_SUPPORT_MATRIX.harnesses).map((harness) => ({
    id: harness.id,
    module: path.join(installedRoot, harness.probeModule),
    fn: harness.probeFunction,
  }));
  const results = [];
  for (const probe of probes) {
    try {
      if (!fs.existsSync(probe.module)) {
        results.push({
          harnessId: probe.id,
          status: "unavailable",
          qualified: false,
          reason: `module_not_found: ${probe.module}`,
        });
        continue;
      }
      const imported = await import(pathToFileURL(probe.module).href);
      const installation = await imported[probe.fn]({ checkPermissions: true });
      if (!installation) {
        results.push({
          harnessId: probe.id,
          status: "unavailable",
          qualified: false,
          reason: "not_detected",
        });
        continue;
      }
      const qualified = installation.status === "ready" && installation.isInstalled === true;
      results.push({
        harnessId: probe.id,
        status: qualified ? "ready" : "unavailable",
        qualified,
        detectedStatus: installation.status,
        version: installation.version ?? null,
        executablePath: installation.executablePath ?? null,
        reason: qualified ? "qualified" : `status_${installation.status}`,
      });
    } catch (error) {
      results.push({
        harnessId: probe.id,
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
    const artifactLayout = validateArtifactLayout(installedRoot);
    let status = "ARTIFACT_VALIDATED";
    let checks = {
      artifactDigest: true,
      platformMetadata: true,
      artifactLayout,
    };
    let harnesses = [];
    if (mode === "native") {
      baseEvidence.execution.runtimeExercised = true;
      const cli = qualifyCli(installedRoot, sandboxDir, manifest);
      const daemon = await qualifyDaemon(installedRoot, sandboxDir);
      const mcp = await qualifyMcp(installedRoot, sandboxDir);
      harnesses = await probeHarnesses(installedRoot);
      status = "QUALIFIED";
      checks = {
        ...checks,
        packagedCli: cli,
        daemon,
        mcp,
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
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  }
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
    }
  }
  return options;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.emitMatrix) {
    process.stdout.write(`${emitSupportMatrix({ format: "json" })}\n`);
    process.exitCode = 0;
  } else {
    const result = await runPlatformQualification(parsed);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.passed ? 0 : 1;
  }
}
