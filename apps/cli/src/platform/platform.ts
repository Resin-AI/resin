import os from "node:os";
import process from "node:process";

/**
 * Supported target operating systems for Resin.
 */
export type SupportedPlatform = "linux" | "darwin" | "wsl";

export type PlatformType = SupportedPlatform | "win32" | "other";

/**
 * Supported hardware architectures.
 */
export type SupportedArch = "x64" | "arm64";

/**
 * The 5 Required Platform Distribution & Qualification Lanes for V1.
 */
export type RequiredQualificationLane =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "wsl";

/**
 * Official Release Qualification & Runtime Lanes (including WSL supervisor variants).
 */
export type PlatformQualificationLane =
  | "linux-x64"
  | "linux-arm64"
  | "darwin-x64"
  | "darwin-arm64"
  | "wsl-systemd"
  | "wsl-fallback";

export const REQUIRED_QUALIFICATION_LANES: readonly RequiredQualificationLane[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl",
] as const;

export const ALL_QUALIFICATION_LANES: readonly PlatformQualificationLane[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "wsl-systemd",
  "wsl-fallback",
] as const;

export const PINNED_NODE_VERSION = "22";
export const PINNED_PNPM_VERSION = "10.24.0";
export const PINNED_DENO_VERSION = "2.9.5";

/**
 * Product naming and packaging contract.
 */
export interface SupportMatrixProduct {
  readonly productName: "Resin";
  readonly binaryName: "resin";
  readonly packageName: "resin";
  readonly internalNamespace: "@resin";
  readonly releaseVersion: "1.0.0";
  readonly hasResinBinary: false;
  readonly hasResinPackage: false;
  readonly description: string;
}

/**
 * Pinned toolchain and runtime requirements.
 */
export interface SupportMatrixToolchain {
  readonly node: {
    readonly pinned: "22";
    readonly minimum: "22.0.0";
    readonly range: ">=22.0.0";
    readonly lts: true;
    readonly status: "required";
  };
  readonly pnpm: {
    readonly pinned: "10.24.0";
    readonly minimum: "10.0.0";
    readonly packageManager: "pnpm@10.24.0";
    readonly status: "required";
  };
  readonly deno: {
    readonly pinned: "2.9.5";
    readonly minimum: "2.0.0";
    readonly range: ">=2.0.0 <3.0.0";
    readonly assetVersion: "2.9.5";
    readonly status: "required";
  };
}

/**
 * Supported platform descriptor.
 */
export interface SupportMatrixPlatform {
  readonly id: RequiredQualificationLane;
  readonly os: "linux" | "darwin";
  readonly arch: "x64" | "arm64";
  readonly isWsl: boolean;
  readonly wslVersion?: 2;
  readonly displayName: string;
  readonly tier: 1;
  readonly serviceManager: "systemd" | "launchd" | "systemd | fallback";
  readonly tarball: string;
  readonly qualified: true;
  readonly minimumOsVersion: string;
}

/**
 * AI coding harness adapter qualification descriptor.
 */
export interface SupportMatrixHarness {
  readonly id: string;
  readonly name: string;
  readonly adapterPackage: string;
  readonly supportedVersions: readonly string[];
  readonly qualifiedVersions: readonly string[];
  readonly protocol: "mcp";
  readonly transports: readonly string[];
  readonly probeModule: string;
  readonly probeFunction: string;
}

/**
 * Shell and package manager execution assumptions.
 */
export interface SupportMatrixEnvironmentAssumptions {
  readonly shells: {
    readonly supported: readonly ["bash", "zsh", "sh"];
    readonly posixCompliant: true;
    readonly profileFiles: readonly [".bashrc", ".zshrc", ".profile"];
  };
  readonly packageManagers: {
    readonly pnpm: {
      readonly supported: true;
      readonly recommended: true;
      readonly version: "10.24.0";
    };
    readonly npm: {
      readonly supported: true;
      readonly recommended: false;
      readonly minVersion: "9.0.0";
    };
    readonly yarn: {
      readonly supported: false;
      readonly recommended: false;
      readonly reason: string;
    };
  };
}

/**
 * Explicit limitations and unsupported environment specifications.
 */
export interface SupportMatrixLimitations {
  readonly nativeWindows: {
    readonly supported: false;
    readonly impliedByWsl2: false;
    readonly reason: string;
    readonly rejectionMessage: string;
  };
  readonly wsl1: {
    readonly supported: false;
    readonly reason: string;
  };
  readonly nodeUnder22: {
    readonly supported: false;
    readonly reason: string;
  };
  readonly unsupportedArchitectures: {
    readonly supported: false;
    readonly architectures: readonly ["ia32", "mips", "ppc", "s390", "armv7l"];
    readonly reason: string;
  };
}

/**
 * Canonical Machine-Readable V1 Support Matrix Contract.
 */
export interface V1SupportMatrix {
  readonly schemaVersion: "2.0.0";
  readonly releaseVersion: "1.0.0";
  readonly product: SupportMatrixProduct;
  readonly toolchain: SupportMatrixToolchain;
  readonly platforms: readonly SupportMatrixPlatform[];
  readonly qualificationLanes: readonly RequiredQualificationLane[];
  readonly runtimeLanes: readonly PlatformQualificationLane[];
  readonly harnesses: {
    readonly "claude-code": SupportMatrixHarness;
    readonly "codex-cli": SupportMatrixHarness;
    readonly omp: SupportMatrixHarness;
  };
  readonly environmentAssumptions: SupportMatrixEnvironmentAssumptions;
  readonly limitations: SupportMatrixLimitations;
}

/**
 * Immutable canonical V1 Support Matrix.
 */
export const V1_SUPPORT_MATRIX: V1SupportMatrix = Object.freeze({
  schemaVersion: "2.0.0",
  releaseVersion: "1.0.0",
  product: Object.freeze({
    productName: "Resin",
    binaryName: "resin",
    packageName: "resin",
    internalNamespace: "@resin",
    releaseVersion: "1.0.0",
    hasResinBinary: false,
    hasResinPackage: false,
    description:
      "Compiles recurring coding-agent work into tools that use less inference, lower inference cost, and finish faster",
  }),
  toolchain: Object.freeze({
    node: Object.freeze({
      pinned: "22",
      minimum: "22.0.0",
      range: ">=22.0.0",
      lts: true,
      status: "required",
    }),
    pnpm: Object.freeze({
      pinned: "10.24.0",
      minimum: "10.0.0",
      packageManager: "pnpm@10.24.0",
      status: "required",
    }),
    deno: Object.freeze({
      pinned: "2.9.5",
      minimum: "2.0.0",
      range: ">=2.0.0 <3.0.0",
      assetVersion: "2.9.5",
      status: "required",
    }),
  }),
  platforms: Object.freeze([
    Object.freeze({
      id: "linux-x64",
      os: "linux",
      arch: "x64",
      isWsl: false,
      displayName: "Linux x86_64 (glibc / musl)",
      tier: 1,
      serviceManager: "systemd",
      tarball: "resin-v1.0.0-linux-x64.tar.gz",
      qualified: true,
      minimumOsVersion: "Kernel 5.4+ (glibc >= 2.31)",
    }),
    Object.freeze({
      id: "linux-arm64",
      os: "linux",
      arch: "arm64",
      isWsl: false,
      displayName: "Linux aarch64 (ARM64)",
      tier: 1,
      serviceManager: "systemd",
      tarball: "resin-v1.0.0-linux-arm64.tar.gz",
      qualified: true,
      minimumOsVersion: "Kernel 5.4+ (glibc >= 2.31)",
    }),
    Object.freeze({
      id: "darwin-x64",
      os: "darwin",
      arch: "x64",
      isWsl: false,
      displayName: "macOS Intel (x86_64)",
      tier: 1,
      serviceManager: "launchd",
      tarball: "resin-v1.0.0-darwin-x64.tar.gz",
      qualified: true,
      minimumOsVersion: "macOS 12 Monterey+",
    }),
    Object.freeze({
      id: "darwin-arm64",
      os: "darwin",
      arch: "arm64",
      isWsl: false,
      displayName: "macOS Apple Silicon (ARM64 M1/M2/M3/M4)",
      tier: 1,
      serviceManager: "launchd",
      tarball: "resin-v1.0.0-darwin-arm64.tar.gz",
      qualified: true,
      minimumOsVersion: "macOS 12 Monterey+",
    }),
    Object.freeze({
      id: "wsl",
      os: "linux",
      arch: "x64",
      isWsl: true,
      wslVersion: 2,
      displayName: "WSL2 (Windows Subsystem for Linux 2 x64)",
      tier: 1,
      serviceManager: "systemd | fallback",
      tarball: "resin-v1.0.0-wsl.tar.gz",
      qualified: true,
      minimumOsVersion: "WSL2 (Ubuntu 22.04+)",
    }),
  ]),
  qualificationLanes: REQUIRED_QUALIFICATION_LANES,
  runtimeLanes: ALL_QUALIFICATION_LANES,
  harnesses: Object.freeze({
    "claude-code": Object.freeze({
      id: "claude-code",
      name: "Claude Code",
      adapterPackage: "@resin/adapter-claude-code",
      supportedVersions: Object.freeze([">=0.1.0", ">=0.2.0", ">=1.0.0"]),
      qualifiedVersions: Object.freeze(["0.2.14", "1.0.0"]),
      protocol: "mcp",
      transports: Object.freeze(["sse", "stdio"]),
      probeModule: "adapters/claude-code/dist/index.js",
      probeFunction: "probeClaudeInstallation",
    }),
    "codex-cli": Object.freeze({
      id: "codex-cli",
      name: "Codex CLI",
      adapterPackage: "@resin/adapter-codex",
      supportedVersions: Object.freeze([">=0.45.0"]),
      qualifiedVersions: Object.freeze(["0.45.0"]),
      protocol: "mcp",
      transports: Object.freeze(["stdio", "sse"]),
      probeModule: "adapters/codex-cli/dist/index.js",
      probeFunction: "probeCodexInstallation",
    }),
    omp: Object.freeze({
      id: "omp",
      name: "Oh My Pi",
      adapterPackage: "@resin/adapter-omp",
      supportedVersions: Object.freeze([">=0.1.0"]),
      qualifiedVersions: Object.freeze(["0.12.5", "1.0.0"]),
      protocol: "mcp",
      transports: Object.freeze(["stdio", "sse", "websocket", "http"]),
      probeModule: "adapters/omp/dist/index.js",
      probeFunction: "probeOmpInstallation",
    }),
  }),
  environmentAssumptions: Object.freeze({
    shells: Object.freeze({
      supported: Object.freeze(["bash", "zsh", "sh"] as const),
      posixCompliant: true,
      profileFiles: Object.freeze([".bashrc", ".zshrc", ".profile"] as const),
    }),
    packageManagers: Object.freeze({
      pnpm: Object.freeze({
        supported: true,
        recommended: true,
        version: "10.24.0",
      }),
      npm: Object.freeze({
        supported: true,
        recommended: false,
        minVersion: "9.0.0",
      }),
      yarn: Object.freeze({
        supported: false,
        recommended: false,
        reason: "Unsupported package manager; npm or pnpm required",
      }),
    }),
  }),
  limitations: Object.freeze({
    nativeWindows: Object.freeze({
      supported: false,
      impliedByWsl2: false,
      reason:
        "Native Windows (win32) is unsupported. Resin must run inside WSL2 (Windows Subsystem for Linux): `wsl --install`.",
      rejectionMessage:
        "Native Windows is not supported. Please run within Windows Subsystem for Linux (WSL2): `wsl --install`.",
    }),
    wsl1: Object.freeze({
      supported: false,
      reason:
        "WSL1 is unsupported due to missing Linux socket and filesystem semantics; WSL2 is required.",
    }),
    nodeUnder22: Object.freeze({
      supported: false,
      reason:
        "Node.js versions earlier than 22.0.0 are unsupported; Node.js 22 LTS or newer is required.",
    }),
    unsupportedArchitectures: Object.freeze({
      supported: false,
      architectures: Object.freeze(["ia32", "mips", "ppc", "s390", "armv7l"] as const),
      reason:
        "32-bit and non-standard architectures are unsupported; only x64 and arm64 are supported.",
    }),
  }),
});

/**
 * Emits the canonical machine-readable V1 support matrix.
 */
export function emitSupportMatrix(options: { format: "json" }): string;
export function emitSupportMatrix(options?: { format?: "object" }): V1SupportMatrix;
export function emitSupportMatrix(options?: { format?: "json" | "object" }):
  | V1SupportMatrix
  | string;
export function emitSupportMatrix(
  options: { format?: "json" | "object" } = {},
): V1SupportMatrix | string {
  if (options.format === "json") {
    return JSON.stringify(V1_SUPPORT_MATRIX, null, 2);
  }
  return V1_SUPPORT_MATRIX;
}

/**
 * Detailed platform inspection result.
 */
export interface PlatformInfo {
  readonly os: SupportedPlatform;
  readonly isSupported: boolean;
  readonly rejectionReason?: string;
  readonly isWsl: boolean;
  readonly wslVersion?: number;
  readonly wslDistro?: string;
  readonly hasSystemd?: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly distro?: string;
  readonly isAppleSilicon?: boolean;
  readonly isRosetta?: boolean;
  readonly lane?: PlatformQualificationLane;
}

/**
 * Custom error thrown when the host platform is unsupported.
 */
export class UnsupportedPlatformError extends Error {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly isWsl: boolean;

  constructor(
    platform: NodeJS.Platform,
    details?: { arch?: string; nodeVersion?: string; isWsl?: boolean },
  ) {
    const message =
      platform === "win32"
        ? V1_SUPPORT_MATRIX.limitations.nativeWindows.rejectionMessage
        : `Unsupported platform: ${String(platform)}. Resin requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    super(message);
    this.name = "UnsupportedPlatformError";
    this.platform = platform;
    this.arch = details?.arch ?? process.arch;
    this.nodeVersion = details?.nodeVersion ?? process.version;
    this.isWsl = details?.isWsl ?? false;
  }
}

/**
 * Detects whether the current runtime environment is WSL (Windows Subsystem for Linux).
 */
export function isWslEnvironment(
  env: Record<string, string | undefined> = process.env,
  release?: string,
): boolean {
  if (env.WSL_DISTRO_NAME || env.IS_WSL || env.WSLENV || env.WSL_INTEROP) {
    return true;
  }

  const kernelRelease = (
    release ?? (process.platform === "linux" ? os.release() : "")
  ).toLowerCase();
  if (kernelRelease.includes("microsoft") || kernelRelease.includes("wsl")) {
    return true;
  }

  return false;
}

/**
 * Checks if the system is running on Apple Silicon (arm64 Darwin).
 */
export function isAppleSilicon(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (platform !== "darwin") {
    return false;
  }
  if (arch === "arm64") {
    return true;
  }
  // Check for Rosetta translation
  if (env.ROSETTA_VERSION || env.TRANSLATED_PROCESS === "1") {
    return true;
  }
  return false;
}

/**
 * Determines the qualification lane for a given platform info.
 */
export function getQualificationLane(info: PlatformInfo): PlatformQualificationLane {
  if (info.isWsl) {
    return info.hasSystemd ? "wsl-systemd" : "wsl-fallback";
  }
  if (info.os === "darwin") {
    return info.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  }
  if (info.os === "linux") {
    return info.arch === "arm64" ? "linux-arm64" : "linux-x64";
  }
  // Default to linux-x64
  return "linux-x64";
}

/**
 * Gets a human-readable display name for a platform lane or platform info.
 */
export function isPlatformInfo(
  value: PlatformQualificationLane | RequiredQualificationLane | PlatformInfo | string,
): value is PlatformInfo {
  return (
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

export function getPlatformDisplayName(
  lane: PlatformQualificationLane | RequiredQualificationLane | string,
): string;
export function getPlatformDisplayName(info: PlatformInfo): string;
export function getPlatformDisplayName(
  laneOrInfo: PlatformQualificationLane | RequiredQualificationLane | PlatformInfo | string,
): string {
  if (isPlatformInfo(laneOrInfo)) {
    if (laneOrInfo.isWsl) {
      return laneOrInfo.hasSystemd ? "WSL2 (systemd enabled)" : "WSL2 (supervisor fallback mode)";
    }
    const lane = getQualificationLane(laneOrInfo);
    return getPlatformDisplayName(lane);
  }
  switch (laneOrInfo) {
    case "linux-x64":
      return "Linux x86_64 (glibc / musl)";
    case "linux-arm64":
      return "Linux aarch64 (ARM64)";
    case "darwin-x64":
      return "macOS Intel (x86_64)";
    case "darwin-arm64":
      return "macOS Apple Silicon (ARM64 M1/M2/M3/M4)";
    case "wsl":
      return "WSL2 (Windows Subsystem for Linux 2 x64)";
    case "wsl-systemd":
      return "WSL2 (systemd enabled)";
    case "wsl-fallback":
      return "WSL2 (supervisor fallback mode)";
    default:
      return `Unknown platform (${laneOrInfo})`;
  }
}

/**
 * Detects and inspects the host platform.
 */
export function detectPlatform(
  options: {
    platform?: NodeJS.Platform;
    arch?: string;
    env?: Record<string, string | undefined>;
    release?: string;
    nodeVersion?: string;
    hasSystemdOverride?: boolean;
  } = {},
): PlatformInfo {
  const targetPlatform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.version;

  const isWsl = isWslEnvironment(env, options.release);
  const appleSilicon = isAppleSilicon(targetPlatform, arch, env);

  let wslDistro: string | undefined;
  let wslVersion: number | undefined;
  let hasSystemd: boolean | undefined;

  if (isWsl) {
    wslDistro = env.WSL_DISTRO_NAME ?? "Ubuntu";
    wslVersion = 2; // Modern WSL2 standard
    hasSystemd =
      options.hasSystemdOverride ??
      (env.WSL_SYSTEMD === "1" || env.SYSTEMD_ENABLED === "1" || Boolean(env.INVOCATION_ID));
  }

  let osType: SupportedPlatform = "linux";
  if (isWsl) {
    osType = "wsl";
  } else if (targetPlatform === "darwin") {
    osType = "darwin";
  } else if (targetPlatform === "linux") {
    osType = "linux";
  }

  let distro: string | undefined;
  if (isWsl) {
    distro = wslDistro ?? "linux-wsl";
  } else if (targetPlatform === "linux") {
    distro = env.ID ?? env.DISTRIB_ID ?? "linux-generic";
  } else if (targetPlatform === "darwin") {
    distro = "macOS";
  }

  const isSupported = targetPlatform === "linux" || targetPlatform === "darwin";
  let rejectionReason: string | undefined;
  if (!isSupported) {
    if (targetPlatform === "win32") {
      rejectionReason = V1_SUPPORT_MATRIX.limitations.nativeWindows.rejectionMessage;
    } else {
      rejectionReason = `Operating system '${targetPlatform}' is not supported. Resin requires Linux (x64/arm64), macOS (Apple Silicon/Intel), or WSL2.`;
    }
  }

  const info: PlatformInfo = {
    os: osType,
    isSupported,
    rejectionReason,
    isWsl,
    wslVersion,
    wslDistro,
    hasSystemd,
    platform: targetPlatform,
    arch,
    nodeVersion,
    distro,
    isAppleSilicon: appleSilicon,
    isRosetta: targetPlatform === "darwin" && arch === "x64" && Boolean(env.ROSETTA_VERSION),
  };

  const lane = getQualificationLane(info);
  return {
    ...info,
    lane,
  };
}

/**
 * Validates that the detected platform is fully supported.
 * Throws UnsupportedPlatformError if unsupported.
 */
export function validatePlatform(info: PlatformInfo = detectPlatform()): PlatformInfo {
  if (!info.isSupported) {
    throw new UnsupportedPlatformError(info.platform, {
      arch: info.arch,
      nodeVersion: info.nodeVersion,
      isWsl: info.isWsl,
    });
  }

  // Double-check platform against allowed list
  if (info.platform !== "linux" && info.platform !== "darwin") {
    throw new UnsupportedPlatformError(info.platform, {
      arch: info.arch,
      nodeVersion: info.nodeVersion,
      isWsl: info.isWsl,
    });
  }

  return info;
}
