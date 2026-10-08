import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, describe, expect, it } from "vitest";
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
  qualifyPlatformLane,
  requiredArtifactFiles,
  splitScheduledTaskName,
  tomlLaunchMatches,
} from "./platform-qualification.mjs";

describe("real host platform qualification", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resin-platform-qual-"));
  const releaseDir = path.join(tempRoot, "release");
  const outputDir = path.join(tempRoot, "evidence");

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
});
