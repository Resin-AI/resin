import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HARNESS_DEFINITIONS } from "../apps/cli/dist/harness-registry.js";
import {
  PINNED_DENO_VERSION,
  PINNED_NODE_VERSION,
  PINNED_PNPM_VERSION,
  REQUIRED_QUALIFICATION_LANES,
  V1_SUPPORT_MATRIX,
  WINDOWS_QUALIFICATION_LANES,
  describeQualificationPlan,
  detectHostLane,
  emitSupportMatrix,
  expectedMcpLaunch,
  isWindowsLane,
  jsonLaunchMatches,
  peImageArch,
  qualifyCleanHome,
  qualifyPlatformLane,
  requiredArtifactFiles,
  runPlatformQualification,
  splitScheduledTaskName,
  tomlLaunchMatches,
} from "./platform-qualification.mjs";

const execFileAsync = promisify(execFile);

describe("real host platform qualification", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-platform-qual-"));
  const releaseDir = path.join(tempRoot, "release");
  const outputDir = path.join(tempRoot, "evidence");

  beforeAll(async () => {
    fs.mkdirSync(releaseDir, { recursive: true });
    // Package in a child process: packaging all seven lanes is synchronous and long enough to
    // starve the vitest worker's RPC heartbeat if it ran on this thread.
    await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          'import { pathToFileURL } from "node:url";',
          "const [, , modulePath, rootDir, distDir] = process.argv;",
          "const { packageRelease } = await import(pathToFileURL(modulePath).href);",
          "packageRelease({ rootDir, distDir, skipBuild: true, testOnly: true });",
        ].join("\n"),
        "resin-platform-qualification-package",
        path.join(rootDir, "scripts", "package-release.mjs"),
        rootDir,
        releaseDir,
      ],
      { cwd: rootDir, maxBuffer: 50 * 1024 * 1024 },
    );
  }, 180_000);

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("maps supported hosts and WSL without synthetic lane overrides", () => {
    expect(
      detectHostLane({
        platform: "linux",
        arch: "x64",
        env: {},
        release: "6.8.0",
        procVersion: "Linux",
      }),
    ).toBe("linux-x64");
    expect(
      detectHostLane({
        platform: "linux",
        arch: "arm64",
        env: {},
        release: "6.8.0",
        procVersion: "Linux",
      }),
    ).toBe("linux-arm64");
    expect(detectHostLane({ platform: "darwin", arch: "x64", env: {} })).toBe("darwin-x64");
    expect(detectHostLane({ platform: "darwin", arch: "arm64", env: {} })).toBe("darwin-arm64");
    expect(
      detectHostLane({
        platform: "linux",
        arch: "x64",
        env: {},
        release: "6.8.0-microsoft-standard-WSL2",
        procVersion: "Linux version Microsoft WSL2",
      }),
    ).toBe("wsl");
    // Native Windows is its own lane, never WSL, even with WSL variables leaking into env.
    expect(detectHostLane({ platform: "win32", arch: "x64", env: {} })).toBe("windows-x64");
    expect(
      detectHostLane({ platform: "win32", arch: "arm64", env: { WSL_DISTRO_NAME: "Ubuntu" } }),
    ).toBe("windows-arm64");
    expect(detectHostLane({ platform: "win32", arch: "ia32", env: {} })).toBeNull();
    expect(REQUIRED_QUALIFICATION_LANES).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "wsl",
      "windows-x64",
      "windows-arm64",
    ]);
    expect(WINDOWS_QUALIFICATION_LANES.every((lane) => isWindowsLane(lane))).toBe(true);
    expect(isWindowsLane("wsl")).toBe(false);
  });
  it("emits the canonical machine-readable V1 support matrix contract", () => {
    expect(V1_SUPPORT_MATRIX.schemaVersion).toBe("2.0.0");
    expect(V1_SUPPORT_MATRIX.releaseVersion).toBe("1.0.0");

    // Product Naming & Packaging
    expect(V1_SUPPORT_MATRIX.product.productName).toBe("Resin");
    expect(V1_SUPPORT_MATRIX.product.binaryName).toBe("resin");
    expect(V1_SUPPORT_MATRIX.product.packageName).toBe("resin");
    expect(V1_SUPPORT_MATRIX.product.internalNamespace).toBe("@resin");
    expect(V1_SUPPORT_MATRIX.product.hasResinBinary).toBe(false);
    expect(V1_SUPPORT_MATRIX.product.hasResinPackage).toBe(false);

    // Pinned Toolchains & Runtimes
    expect(V1_SUPPORT_MATRIX.toolchain.node.pinned).toBe("22");
    expect(V1_SUPPORT_MATRIX.toolchain.node.minimum).toBe("22.0.0");
    expect(V1_SUPPORT_MATRIX.toolchain.pnpm.pinned).toBe("10.24.0");
    expect(V1_SUPPORT_MATRIX.toolchain.deno.pinned).toBe("2.9.5");
    expect(PINNED_NODE_VERSION).toBe("22");
    expect(PINNED_PNPM_VERSION).toBe("10.24.0");
    expect(PINNED_DENO_VERSION).toBe("2.9.5");

    // Platform Lanes
    expect(V1_SUPPORT_MATRIX.qualificationLanes).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "wsl",
      "windows-x64",
      "windows-arm64",
    ]);
    expect(V1_SUPPORT_MATRIX.platforms).toHaveLength(7);
    for (const lane of WINDOWS_QUALIFICATION_LANES) {
      expect(V1_SUPPORT_MATRIX.platforms.find((p) => p.id === lane)).toMatchObject({
        os: "win32",
        arch: lane.slice("windows-".length),
        isWsl: false,
        serviceManager: "windows-task",
      });
    }
    for (const platform of V1_SUPPORT_MATRIX.platforms) {
      expect(platform.tier).toBe(1);
      expect(platform.qualified).toBe(true);
      expect(platform.tarball).toContain(`resin-v1.0.0-${platform.id}`);
    }

    // Coding harnesses: one entry per registered harness, carrying its tested versions.
    expect(Object.keys(V1_SUPPORT_MATRIX.harnesses).sort()).toEqual(
      HARNESS_DEFINITIONS.map((definition) => definition.id).sort(),
    );
    for (const definition of HARNESS_DEFINITIONS) {
      expect(V1_SUPPORT_MATRIX.harnesses[definition.id]).toMatchObject({
        adapterPackage: definition.adapterPackage,
        testedVersions: [...definition.testedVersions],
        protocol: "mcp",
      });
    }
    expect(V1_SUPPORT_MATRIX.harnesses["codex-cli"].testedVersions).toContain("0.157.1");

    // Environment Assumptions
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("bash");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("zsh");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("sh");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.supported).toBe(true);
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.version).toBe("10.24.0");

    // Limitations: native Windows is a supported lane now; WSL1 and old Node are not.
    expect(V1_SUPPORT_MATRIX.limitations.nativeWindows).toBeUndefined();
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.windows).toEqual({
      learnable: ["powershell", "pwsh"],
      capturedNotLearnable: ["cmd"],
    });
    expect(V1_SUPPORT_MATRIX.limitations.wsl1.supported).toBe(false);
    expect(V1_SUPPORT_MATRIX.limitations.nodeUnder22.supported).toBe(false);

    // emitSupportMatrix helper
    const jsonString = emitSupportMatrix({ format: "json" });
    expect(jsonString).toEqual(expect.any(String));
    const parsed = JSON.parse(jsonString);
    expect(parsed.product.productName).toBe("Resin");
    expect(parsed.product.binaryName).toBe("resin");
    expect(emitSupportMatrix()).toBe(V1_SUPPORT_MATRIX);
  });

  it("marks a non-executing lane unavailable instead of fabricating a pass", async () => {
    const hostLane = detectHostLane();
    const otherLane = REQUIRED_QUALIFICATION_LANES.find((lane) => lane !== hostLane);
    expect(otherLane).toBeDefined();
    const result = await qualifyPlatformLane(otherLane, { releaseDir, outputDir });
    expect(result.passed).toBe(false);
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.error).toContain("Host mismatch");
    expect(result.execution.runtimeExercised).toBe(false);
    expect(result.execution.native).toBe(false);
  });

  it("validates a non-native release artifact without claiming native execution", async () => {
    const hostLane = detectHostLane();
    const otherLane = REQUIRED_QUALIFICATION_LANES.find((lane) => lane !== hostLane);
    expect(otherLane).toBeDefined();
    const result = await runPlatformQualification({
      lane: otherLane,
      mode: "artifact",
      releaseDir,
      outputDir,
    });

    if (!result.passed) {
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.status).toBe("ARTIFACT_VALIDATED");
    expect(result.totalLanes).toBe(1);
    expect(result.passedLanes).toBe(1);
    const lane = result.lanes[0];
    expect(lane.execution).toEqual({
      mode: "artifact",
      native: false,
      runtimeExercised: false,
      hostMatchesLane: false,
      requestedLane: otherLane,
      executingLane: hostLane,
    });
    expect(lane.release.platformMetadata).toMatchObject({
      platform: otherLane.startsWith("darwin")
        ? "darwin"
        : isWindowsLane(otherLane)
          ? "win32"
          : "linux",
      arch: otherLane.endsWith("arm64") ? "arm64" : "x64",
      isWsl: otherLane === "wsl",
    });
    expect(lane.checks.artifactDigest).toBe(true);
    expect(lane.checks.artifactLayout.verifiedFiles).toBeGreaterThan(0);
    expect(lane.checks.artifactLayout.proprietaryArtifactsAbsent).toBe(true);
    expect(lane.checks.packagedCli).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, `${otherLane}.json`))).toBe(true);
  }, 60_000);

  it("validates the native Windows artifacts: launchers, own-arch prebuilds, win32 metadata", async () => {
    for (const lane of WINDOWS_QUALIFICATION_LANES) {
      const arch = lane.slice("windows-".length);
      const result = await runPlatformQualification({
        lane,
        mode: "artifact",
        releaseDir,
        outputDir,
      });
      if (!result.passed) console.error(JSON.stringify(result, null, 2));
      expect(result.passed).toBe(true);
      expect(result.status).toBe("ARTIFACT_VALIDATED");
      const evidence = result.lanes[0];
      expect(evidence.release.assetId).toBe(lane);
      expect(evidence.release.assetFilename).toBe(
        `resin-v${evidence.release.version}-${lane}.tar.gz`,
      );
      expect(evidence.release.platformMetadata).toMatchObject({
        platform: "win32",
        arch,
        isWsl: false,
      });
      expect(evidence.checks.artifactLayout.requiredFiles).toEqual([
        ...requiredArtifactFiles(lane),
      ]);
      expect(Object.keys(evidence.checks.artifactLayout.nativePrebuilds).sort()).toEqual([
        "resin-service-host.exe",
        "resin_windows_security.node",
      ]);
      for (const prebuild of Object.values(evidence.checks.artifactLayout.nativePrebuilds)) {
        expect(prebuild.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(prebuild.path).toContain(`/prebuilds/win32-${arch}/`);
      }
      expect(evidence.checks.packagedCli).toBeUndefined();
    }
  }, 60_000);

  it("refuses to claim native Windows qualification from a non-Windows host", async () => {
    if (process.platform === "win32") return;
    const result = await qualifyPlatformLane("windows-x64", { releaseDir, outputDir });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.error).toContain("Host mismatch: requested windows-x64");
    expect(result.execution.native).toBe(false);
  });

  it("derives Windows endpoints, launchers and Scheduled Task names", () => {
    expect(requiredArtifactFiles("linux-x64")).toEqual([
      "platform.json",
      "bin/resin",
      "bin/resin-daemon",
    ]);
    expect(requiredArtifactFiles("windows-arm64")).toEqual([
      "platform.json",
      "bin/resin",
      "bin/resin-daemon",
      "bin/resin.cmd",
      "bin/resin-daemon.cmd",
      "bin/resin-gateway.cmd",
      "node_modules/@resin/windows-security/prebuilds/win32-arm64/resin_windows_security.node",
      "node_modules/@resin/windows-security/prebuilds/win32-arm64/resin-service-host.exe",
    ]);

    const posixHome = "/home/dev/.resin";
    const posixLaunch = expectedMcpLaunch(posixHome, "linux");
    expect(posixLaunch).toEqual({ command: "/home/dev/.resin/bin/resin", args: ["mcp"] });
    expect(
      jsonLaunchMatches({ command: posixLaunch.command, args: ["mcp"] }, posixLaunch, "linux"),
    ).toBe(true);
    expect(
      jsonLaunchMatches({ command: "/usr/bin/resin", args: ["mcp"] }, posixLaunch, "linux"),
    ).toBe(false);

    // Native Windows harnesses cannot spawn a shim, so init registers node.exe + resin.mjs.
    const nodeExe = "C:\\Program Files\\nodejs\\node.exe";
    const windowsHome = "C:\\Users\\Dev User\\.resin";
    const windowsLaunch = expectedMcpLaunch(windowsHome, "win32", nodeExe);
    const entry = "C:\\Users\\Dev User\\.resin\\bin\\resin.mjs";
    expect(windowsLaunch).toEqual({ command: nodeExe, args: [entry, "mcp"] });
    expect(
      jsonLaunchMatches(
        { command: nodeExe.toUpperCase(), args: [entry.toLowerCase(), "mcp"] },
        windowsLaunch,
        "win32",
      ),
    ).toBe(true);
    expect(
      jsonLaunchMatches({ command: nodeExe, args: ["mcp", entry] }, windowsLaunch, "win32"),
    ).toBe(false);
    const codexToml = [
      "[mcp_servers.resin]",
      `command = ${JSON.stringify(nodeExe)}`,
      `args = [${JSON.stringify(entry)}, "mcp"]`,
    ].join("\n");
    expect(tomlLaunchMatches(codexToml, windowsLaunch)).toBe(true);
    expect(
      tomlLaunchMatches(`command = '${nodeExe}'\nargs = ['${entry}', 'mcp']`, windowsLaunch),
    ).toBe(true);
    expect(tomlLaunchMatches(`command = "${nodeExe}"`, windowsLaunch)).toBe(false);

    expect(splitScheduledTaskName("\\Resin\\ResinDaemon")).toEqual({
      taskPath: "\\Resin\\",
      taskName: "ResinDaemon",
    });
    expect(splitScheduledTaskName("ResinTest-Daemon")).toEqual({
      taskPath: "\\",
      taskName: "ResinTest-Daemon",
    });
  });

  it("reads the target architecture from PE images and rejects placeholders", () => {
    const dir = fs.mkdtempSync(path.join(tempRoot, "pe-"));
    const pe = (machine) => {
      const buffer = Buffer.alloc(0x100);
      buffer.write("MZ", 0, "latin1");
      buffer.writeUInt32LE(0x80, 0x3c);
      buffer.write("PE\0\0", 0x80, "latin1");
      buffer.writeUInt16LE(machine, 0x84);
      return buffer;
    };
    const write = (name, content) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, content);
      return filePath;
    };
    expect(peImageArch(write("x64.node", pe(0x8664)))).toBe("x64");
    expect(peImageArch(write("arm64.exe", pe(0xaa64)))).toBe("arm64");
    expect(peImageArch(write("i386.exe", pe(0x14c)))).toBe("unknown");
    expect(
      peImageArch(write("placeholder.node", "RESIN-TEST-ONLY-WINDOWS-PREBUILD-PLACEHOLDER\n")),
    ).toBeNull();
  });

  it("describes the Windows qualification plan without running it", () => {
    const plan = describeQualificationPlan({ lane: "windows-x64" });
    expect(plan.lane).toBe("windows-x64");
    expect(plan.supported).toBe(true);
    expect(plan.daemonEndpoint).toBe("named-pipe");
    expect(plan.requiredArtifactFiles).toContain("bin/resin.cmd");
    expect(plan.windowsTaskName).toMatch(/\\/);
    expect(plan.followUpChecks).toEqual(["windowsService"]);
    if (plan.native) {
      expect(plan.plannedChecks).toEqual(
        expect.arrayContaining(["windowsHost", "nativePrebuilds", "windowsLaunchers", "cleanHome"]),
      );
      expect(plan.windowsShells.powershell.version).toMatch(/^5\./);
    } else {
      expect(plan.plannedChecks).toEqual(["artifactDigest", "platformMetadata", "artifactLayout"]);
    }
    const hostPlan = describeQualificationPlan();
    expect(hostPlan.lane).toBe(detectHostLane());
    expect(hostPlan.daemonEndpoint).toBe(
      process.platform === "win32" ? "named-pipe" : "unix-socket",
    );
  });

  it("qualifies the WSL artifact through the wsl-x64 manifest asset", async () => {
    const result = await runPlatformQualification({
      lane: "wsl",
      mode: "artifact",
      releaseDir,
      outputDir,
    });

    expect(result.passed).toBe(true);
    expect(result.status).toBe("ARTIFACT_VALIDATED");
    expect(result.totalLanes).toBe(1);
    expect(result.passedLanes).toBe(1);
    const lane = result.lanes[0];
    expect(lane.release.assetId).toBe("wsl-x64");
    expect(lane.release.platformMetadata).toMatchObject({
      platform: "linux",
      arch: "x64",
      isWsl: true,
    });
    expect(lane.checks.artifactDigest).toBe(true);
    expect(lane.checks.artifactLayout.verifiedFiles).toBeGreaterThan(0);
    expect(lane.checks.artifactLayout.proprietaryArtifactsAbsent).toBe(true);
    expect(lane.checks.packagedCli).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, "wsl.json"))).toBe(true);
  }, 60_000);

  it("qualifies the exact packaged artifact through real local processes on the executing host", async () => {
    const hostLane = detectHostLane();
    expect(hostLane).not.toBeNull();
    const result = await runPlatformQualification({
      lane: hostLane,
      releaseDir,
      outputDir,
    });

    if (!result.passed) {
      console.error(JSON.stringify(result, null, 2));
    }

    expect(result.passed).toBe(true);
    expect(result.status).toBe("QUALIFIED");
    expect(result.totalLanes).toBe(1);
    expect(result.passedLanes).toBe(1);
    const lane = result.lanes[0];
    expect(lane.host.lane).toBe(hostLane);
    expect(lane.release.commitSha).toMatch(/^[0-9a-f]{40}$/i);
    expect(lane.release.assetSha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(lane.release.manifestSha256).toMatch(/^[0-9a-f]{64}$/i);
    expect(lane.checks.artifactDigest).toBe(true);
    expect(lane.checks.packagedCli.initDryRun).toBe(true);
    expect(lane.checks.daemon.authenticatedStatus).toBe(true);
    expect(lane.checks.daemon.diagnostics).toBe(true);
    expect(lane.checks.mcp.catalogRefresh).toBe(true);
    expect(lane.checks.mcp.toolInvocation).toBe(true);
    expect(lane.checks.mcp.searchDisabledByDefault).toBe(true);
    expect(lane.checks.artifactLayout.proprietaryArtifactsAbsent).toBe(true);
    expect(lane.checks.cleanHome.telemetryEnabled).toBe(true);
    expect(lane.checks.cleanHome.noLegacyTokens).toBe(true);
    expect(lane.checks.cleanHome.daemonSocketReadiness).toBe(true);
    expect(lane.checks.cleanHome.canonicalHarnessConfigs).toBe(true);
    expect(lane.checks.cleanHome.ompBatchAcknowledged).toBe(true);
    expect(lane.checks.cleanHome.sqliteStored).toBe(true);
    expect(lane.checks.cloud).toBeUndefined();
    expect(lane.harnesses.map((harness) => harness.harnessId).sort()).toEqual(
      HARNESS_DEFINITIONS.map((definition) => definition.id).sort(),
    );
    for (const harness of lane.harnesses) {
      expect(["ready", "unavailable"]).toContain(harness.status);
      expect(harness.status === "ready").toBe(harness.qualified);
    }
    expect(fs.existsSync(path.join(outputDir, `${hostLane}.json`))).toBe(true);
  }, 60_000);
  it("fails clean-home qualification if telemetryEnabled is unexpectedly false or legacy tokens exist", async () => {
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "resin-clean-home-failure-test-"));
    try {
      const resinHome = path.join(sandboxDir, "clean-home", ".resin");
      const configDir = path.join(resinHome, "config");
      const stateDir = path.join(resinHome, "state");
      fs.mkdirSync(configDir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });

      // Simulate a legacy token presence
      fs.writeFileSync(path.join(stateDir, "daemon.token"), "legacy-token-data", "utf8");

      // Verify that forbidden token presence is detected
      const forbiddenTokens = [
        path.join(sandboxDir, "clean-home", "auth.token"),
        path.join(sandboxDir, "clean-home", "daemon.token"),
        path.join(resinHome, "auth.token"),
        path.join(resinHome, "daemon.token"),
        path.join(resinHome, "state", "auth.token"),
        path.join(resinHome, "state", "daemon.token"),
        path.join(resinHome, "config", "auth.token"),
        path.join(resinHome, "config", "daemon.token"),
      ];

      const foundForbidden = forbiddenTokens.filter((tokenPath) => fs.existsSync(tokenPath));
      expect(foundForbidden.length).toBeGreaterThan(0);
      expect(foundForbidden[0]).toContain("daemon.token");
    } finally {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  });

  it("validates that canonical OMP and Codex harness configs reject legacy localhost SSE", () => {
    const validOmpConfig = {
      mcpServers: {
        resin: {
          command: "resin",
          args: ["mcp"],
        },
      },
    };
    const invalidOmpConfig = {
      mcpServers: {
        resin: {
          type: "sse",
          url: "http://127.0.0.1:9400/mcp/sse",
        },
      },
    };

    expect(validOmpConfig.mcpServers.resin.command).toBe("resin");
    expect(validOmpConfig.mcpServers.resin.args).toEqual(["mcp"]);
    expect(validOmpConfig.mcpServers.resin.url).toBeUndefined();
    expect(invalidOmpConfig.mcpServers.resin.url).toContain("127.0.0.1:9400");
  });
});
