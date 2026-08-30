import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import type { ConfigFsBridge } from "@resin/harness-contracts";
import { defaultFsBridge } from "@resin/harness-contracts";

const execFileAsync = promisify(execFile);

export type AssetName = "daemon" | "runtime" | "mcp-shim" | "deno";

export interface AssetSpec {
  readonly name: AssetName;
  readonly version: string;
  readonly path: string;
  readonly expectedSha256?: string;
  readonly required: boolean;
  actualSha256?: string;
  verified: boolean;
  notes?: string;
}

export interface AssetManifest {
  readonly schemaVersion: string;
  readonly assets: Record<
    AssetName,
    {
      version: string;
      sha256?: string;
      required?: boolean;
    }
  >;
}

export interface AssetVerificationOptions {
  manifest?: AssetManifest;
  denoExecutable?: string;
  fsBridge?: ConfigFsBridge;
  customPaths?: Partial<Record<AssetName, string>>;
  env?: Record<string, string | undefined>;
  allowMissingOptional?: boolean;
}

export interface AssetVerificationResult {
  readonly allVerified: boolean;
  readonly assets: AssetSpec[];
  readonly missingRequired: string[];
  readonly digestMismatches: Array<{ name: string; expected: string; actual: string }>;
}

/**
 * Calculates deterministic SHA-256 digest of a string or buffer.
 */
export function computeSha256(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Probes for Deno executable on the host system.
 */
export async function findDenoExecutable(
  customPath?: string,
  env: Record<string, string | undefined> = process.env,
  fsBridge: ConfigFsBridge = defaultFsBridge,
): Promise<{ path: string; version?: string } | null> {
  const candidatePaths: string[] = [];

  if (customPath) {
    candidatePaths.push(customPath);
  }
  if (env.DENO_PATH) {
    candidatePaths.push(env.DENO_PATH);
  }
  if (env.DENO_INSTALL) {
    candidatePaths.push(`${env.DENO_INSTALL}/bin/deno`);
  }
  if (env.HOME) {
    candidatePaths.push(`${env.HOME}/.deno/bin/deno`);
  }
  candidatePaths.push("/usr/local/bin/deno", "/usr/bin/deno", "deno");

  for (const candidate of candidatePaths) {
    if (candidate === "deno") {
      try {
        const { stdout } = await execFileAsync("deno", ["--version"], { env });
        const match = stdout.match(/deno\s+([\d.]+)/i);
        return { path: "deno", version: match ? match[1] : undefined };
      } catch {
        // Deno not in PATH
      }
    } else {
      const exists = await fsBridge.exists(candidate);
      if (exists) {
        try {
          const { stdout } = await execFileAsync(candidate, ["--version"], { env });
          const match = stdout.match(/deno\s+([\d.]+)/i);
          if (match?.[1]) return { path: candidate, version: match[1] };
        } catch {
          // Existing path is not a working Deno executable.
        }
      }
    }
  }

  return null;
}

/**
 * Discovers and verifies the integrity of all essential Resin assets.
 */
export async function discoverAndVerifyAssets(
  options: AssetVerificationOptions = {},
): Promise<AssetVerificationResult> {
  const fsBridge = options.fsBridge ?? defaultFsBridge;
  const env = options.env ?? process.env;
  const manifest = options.manifest;

  const results: AssetSpec[] = [];
  const missingRequired: string[] = [];
  const digestMismatches: Array<{ name: string; expected: string; actual: string }> = [];

  // 1. Daemon Asset
  const daemonPath = options.customPaths?.daemon ?? "apps/observer/dist/bin/daemon.js";
  const daemonExpected = manifest?.assets.daemon?.sha256;
  const daemonExists = await fsBridge.exists(daemonPath);
  let daemonActualSha256: string | undefined;

  if (daemonExists) {
    const content = await fsBridge.readFile(daemonPath);
    if (content !== null) {
      daemonActualSha256 = computeSha256(content);
    }
  }

  const daemonDigestOk = !daemonExpected || daemonActualSha256 === daemonExpected;
  if (daemonExpected && daemonActualSha256 && !daemonDigestOk) {
    digestMismatches.push({
      name: "daemon",
      expected: daemonExpected,
      actual: daemonActualSha256,
    });
  }

  const daemonVerified = daemonExists && daemonDigestOk;
  if (!daemonExists && (manifest?.assets.daemon?.required ?? true)) {
    // In mock environments or when building, mark notes
  }

  results.push({
    name: "daemon",
    version: manifest?.assets.daemon?.version ?? "0.1.0",
    path: daemonPath,
    expectedSha256: daemonExpected,
    actualSha256: daemonActualSha256,
    required: manifest?.assets.daemon?.required ?? true,
    verified:
      daemonVerified ||
      (!(manifest?.assets.daemon?.required ?? true) && (options.allowMissingOptional ?? false)),
  });

  // 2. Runtime Asset
  const runtimePath = options.customPaths?.runtime ?? "packages/runtime/dist/index.js";
  const runtimeExpected = manifest?.assets.runtime?.sha256;
  const runtimeExists = await fsBridge.exists(runtimePath);
  let runtimeActualSha256: string | undefined;

  if (runtimeExists) {
    const content = await fsBridge.readFile(runtimePath);
    if (content !== null) {
      runtimeActualSha256 = computeSha256(content);
    }
  }

  const runtimeDigestOk = !runtimeExpected || runtimeActualSha256 === runtimeExpected;
  if (runtimeExpected && runtimeActualSha256 && !runtimeDigestOk) {
    digestMismatches.push({
      name: "runtime",
      expected: runtimeExpected,
      actual: runtimeActualSha256,
    });
  }

  results.push({
    name: "runtime",
    version: manifest?.assets.runtime?.version ?? "0.1.0",
    path: runtimePath,
    expectedSha256: runtimeExpected,
    actualSha256: runtimeActualSha256,
    required: manifest?.assets.runtime?.required ?? true,
    verified:
      (runtimeExists && runtimeDigestOk) ||
      (!(manifest?.assets.runtime?.required ?? true) && (options.allowMissingOptional ?? false)),
  });

  // 3. MCP Shim Asset
  const shimPath = options.customPaths?.["mcp-shim"] ?? "apps/gateway/dist/bin/mcp-shim.js";
  const shimExpected = manifest?.assets["mcp-shim"]?.sha256;
  const shimExists = await fsBridge.exists(shimPath);
  let shimActualSha256: string | undefined;

  if (shimExists) {
    const content = await fsBridge.readFile(shimPath);
    if (content !== null) {
      shimActualSha256 = computeSha256(content);
    }
  }

  const shimDigestOk = !shimExpected || shimActualSha256 === shimExpected;
  if (shimExpected && shimActualSha256 && !shimDigestOk) {
    digestMismatches.push({
      name: "mcp-shim",
      expected: shimExpected,
      actual: shimActualSha256,
    });
  }

  results.push({
    name: "mcp-shim",
    version: manifest?.assets["mcp-shim"]?.version ?? "0.1.0",
    path: shimPath,
    expectedSha256: shimExpected,
    actualSha256: shimActualSha256,
    required: manifest?.assets["mcp-shim"]?.required ?? true,
    verified:
      (shimExists && shimDigestOk) ||
      (!(manifest?.assets["mcp-shim"]?.required ?? true) &&
        (options.allowMissingOptional ?? false)),
  });

  // 4. Deno Sandbox Asset
  const denoInfo = await findDenoExecutable(options.denoExecutable, env, fsBridge);
  const denoExpected = manifest?.assets.deno?.sha256;
  let denoActualSha256: string | undefined;

  if (denoInfo && denoInfo.path !== "deno") {
    const content = await fsBridge.readFile(denoInfo.path);
    if (content !== null) {
      denoActualSha256 = computeSha256(content);
    }
  }

  const denoDigestOk = !denoExpected || denoActualSha256 === denoExpected;
  if (denoExpected && denoActualSha256 && !denoDigestOk) {
    digestMismatches.push({
      name: "deno",
      expected: denoExpected,
      actual: denoActualSha256,
    });
  }

  const denoRequired = manifest?.assets.deno?.required ?? true;
  const denoVerified =
    Boolean(denoInfo) && denoDigestOk
      ? true
      : !denoRequired && (options.allowMissingOptional ?? false);

  results.push({
    name: "deno",
    version: denoInfo?.version ?? manifest?.assets.deno?.version ?? "unknown",
    path: denoInfo?.path ?? options.denoExecutable ?? "deno",
    expectedSha256: denoExpected,
    actualSha256: denoActualSha256,
    required: manifest?.assets.deno?.required ?? true,
    verified: denoVerified,
    notes: denoInfo
      ? `Found Deno at ${denoInfo.path}`
      : "Required Deno runtime was not detected or failed verification.",
  });

  // Determine overall success
  for (const asset of results) {
    if (asset.required && !asset.verified) {
      missingRequired.push(asset.name);
    }
  }

  const allVerified = missingRequired.length === 0 && digestMismatches.length === 0;

  return {
    allVerified,
    assets: results,
    missingRequired,
    digestMismatches,
  };
}
