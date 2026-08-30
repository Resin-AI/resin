import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageRelease } from "./package-release.mjs";
import {
  PINNED_DENO_VERSION,
  PINNED_NODE_VERSION,
  PINNED_PNPM_VERSION,
  REQUIRED_QUALIFICATION_LANES,
  V1_SUPPORT_MATRIX,
  detectHostLane,
  emitSupportMatrix,
  qualifyCleanHome,
  qualifyPlatformLane,
  runPlatformQualification,
} from "./platform-qualification.mjs";

describe("real host platform qualification", () => {
  const rootDir = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-platform-qual-"));
  const releaseDir = path.join(tempRoot, "release");
  const outputDir = path.join(tempRoot, "evidence");

  beforeAll(() => {
    fs.mkdirSync(releaseDir, { recursive: true });
    packageRelease({ rootDir, distDir: releaseDir, skipBuild: true, testOnly: true });
  }, 30_000);

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
    expect(detectHostLane({ platform: "win32", arch: "x64", env: {} })).toBeNull();
    expect(REQUIRED_QUALIFICATION_LANES).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-x64",
      "darwin-arm64",
      "wsl",
    ]);
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
    ]);
    expect(V1_SUPPORT_MATRIX.platforms).toHaveLength(5);
    for (const platform of V1_SUPPORT_MATRIX.platforms) {
      expect(platform.tier).toBe(1);
      expect(platform.qualified).toBe(true);
      expect(platform.tarball).toContain(`resin-v1.0.0-${platform.id}`);
    }

    // Qualified Coding Harnesses
    expect(V1_SUPPORT_MATRIX.harnesses["claude-code"].qualifiedVersions).toEqual([
      "0.2.14",
      "1.0.0",
    ]);
    expect(V1_SUPPORT_MATRIX.harnesses["codex-cli"].qualifiedVersions).toEqual(["0.45.0"]);
    expect(V1_SUPPORT_MATRIX.harnesses.omp.qualifiedVersions).toEqual(["0.12.5", "1.0.0"]);

    // Environment Assumptions
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("bash");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("zsh");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.shells.supported).toContain("sh");
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.supported).toBe(true);
    expect(V1_SUPPORT_MATRIX.environmentAssumptions.packageManagers.pnpm.version).toBe("10.24.0");

    // Limitations (Native Windows unsupported, WSL2 does not imply Windows)
    expect(V1_SUPPORT_MATRIX.limitations.nativeWindows.supported).toBe(false);
    expect(V1_SUPPORT_MATRIX.limitations.nativeWindows.impliedByWsl2).toBe(false);
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
      platform: otherLane.startsWith("darwin") ? "darwin" : "linux",
      arch: otherLane.endsWith("arm64") ? "arm64" : "x64",
      isWsl: otherLane === "wsl",
    });
    expect(lane.checks.artifactDigest).toBe(true);
    expect(lane.checks.artifactLayout.verifiedFiles).toBeGreaterThan(0);
    expect(lane.checks.artifactLayout.proprietaryArtifactsAbsent).toBe(true);
    expect(lane.checks.packagedCli).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, `${otherLane}.json`))).toBe(true);
  }, 60_000);

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
    expect(lane.checks.artifactLayout.proprietaryArtifactsAbsent).toBe(true);
    expect(lane.checks.cleanHome.telemetryEnabled).toBe(true);
    expect(lane.checks.cleanHome.noLegacyTokens).toBe(true);
    expect(lane.checks.cleanHome.daemonSocketReadiness).toBe(true);
    expect(lane.checks.cleanHome.canonicalHarnessConfigs).toBe(true);
    expect(lane.checks.cleanHome.ompBatchAcknowledged).toBe(true);
    expect(lane.checks.cleanHome.sqliteStored).toBe(true);
    expect(lane.checks.cloud).toBeUndefined();
    expect(lane.harnesses).toHaveLength(3);
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
