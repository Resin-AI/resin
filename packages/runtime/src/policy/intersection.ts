import type {
  CanonicalJsonValue,
  CapabilityEnvelope,
  CapabilityLimits,
  CapabilityManifest,
  CommandCapability,
  FsCapability,
  NetCapability,
  SecretCapability,
} from "@resin/contracts";
import {
  canonicalizeCommand,
  canonicalizeEnvName,
  canonicalizeHost,
  canonicalizePath,
  canonicalizePort,
  canonicalizeScheme,
  canonicalizeSecretName,
  canonicalizeSecretPrefix,
  isDangerousEnvVar,
  isPathPermitted,
  isPrivateOrReservedIp,
  isSecretAllowed,
  matchesHostPattern,
  matchesPathPattern,
} from "./canonicalizers.js";

/**
 * Standard policy violation reason codes.
 */
export type PolicyViolationCode =
  | "FS_PATH_EXPANSION"
  | "FS_WRITE_PATH_EXPANSION"
  | "FS_TRAVERSAL_DETECTED"
  | "FS_MAX_FILE_SIZE_EXPANSION"
  | "FS_WORKSPACE_ROOT_FORBIDDEN"
  | "FS_TEMP_FORBIDDEN"
  | "NET_OUTBOUND_FORBIDDEN"
  | "NET_DOMAIN_EXPANSION"
  | "NET_HOST_EXPANSION"
  | "NET_PORT_EXPANSION"
  | "NET_PROTOCOL_EXPANSION"
  | "NET_LOCALHOST_FORBIDDEN"
  | "NET_PRIVATE_IP_BLOCKED"
  | "CMD_SHELL_FORBIDDEN"
  | "CMD_COMMAND_EXPANSION"
  | "CMD_BINARY_EXPANSION"
  | "CMD_FORBIDDEN_PATTERN_VIOLATION"
  | "CMD_ENV_EXPANSION"
  | "SECRET_NAME_EXPANSION"
  | "SECRET_PREFIX_EXPANSION"
  | "SECRET_DIRECT_READ_FORBIDDEN"
  | "LIMIT_EXPANSION"
  | "UNKNOWN_CAPABILITY_TYPE";

export interface PolicyViolation {
  code: PolicyViolationCode;
  subsystem: "fs" | "net" | "command" | "secrets" | "limits" | "general";
  message: string;
  requestedValue?: unknown;
  allowedValue?: unknown;
  details?: Record<string, CanonicalJsonValue>;
}

export interface IntersectionOptions {
  workspaceRoot?: string;
  strictDenyOnExpansion?: boolean;
}

export interface CapabilityIntersectionResult {
  grantCapabilities: CapabilityManifest;
  isExactSubset: boolean;
  expansionAttempted: boolean;
  violations: PolicyViolation[];
}

/**
 * Computes the least-privilege intersection between requested tool capabilities and the approved workspace envelope.
 * Result: grant = manifest ∩ envelope.
 */
export function intersectCapabilities(
  requested: CapabilityManifest,
  envelope: CapabilityEnvelope,
  options: IntersectionOptions = {},
): CapabilityIntersectionResult {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const violations: PolicyViolation[] = [];

  // ===========================================================================
  // 1. Filesystem Subsystem Intersection
  // ===========================================================================
  const reqFs: FsCapability = requested.fs ?? {};
  const envFs: FsCapability = envelope.fs ?? {};

  // Workspace Root permission
  const allowWorkspaceRoot = Boolean(reqFs.allowWorkspaceRoot && envFs.allowWorkspaceRoot);
  if (reqFs.allowWorkspaceRoot && !envFs.allowWorkspaceRoot) {
    violations.push({
      code: "FS_WORKSPACE_ROOT_FORBIDDEN",
      subsystem: "fs",
      message: "Tool requested workspace root access, but workspace envelope forbids it",
      requestedValue: true,
      allowedValue: false,
    });
  }

  // Temp Directory permission
  const allowTemp = Boolean(reqFs.allowTemp && envFs.allowTemp);
  if (reqFs.allowTemp && !envFs.allowTemp) {
    violations.push({
      code: "FS_TEMP_FORBIDDEN",
      subsystem: "fs",
      message: "Tool requested temporary directory access, but workspace envelope forbids it",
      requestedValue: true,
      allowedValue: false,
    });
  }

  // Deny Paths: union of requested and envelope deny paths (cumulative)
  const allDenyPaths = Array.from(
    new Set([...(reqFs.denyPaths ?? []), ...(envFs.denyPaths ?? [])]),
  ).sort();

  // Read Paths intersection
  const grantReadPaths: string[] = [];
  const reqReadPaths = reqFs.readPaths ?? [];
  const envReadPaths = envFs.readPaths ?? [];

  for (const rawPath of reqReadPaths) {
    try {
      const canonPath = canonicalizePath(rawPath, workspaceRoot, {
        allowTemp,
        allowGlob: true,
      });

      // Check if denied by envelope or requested deny list
      const isDenied = allDenyPaths.some((d) => matchesPathPattern(canonPath, d, workspaceRoot));
      if (isDenied) {
        violations.push({
          code: "FS_PATH_EXPANSION",
          subsystem: "fs",
          message: `Read path ${rawPath} is explicitly denied by policy`,
          requestedValue: rawPath,
        });
        continue;
      }

      // Check if allowed by envelope
      const permitted =
        envReadPaths.length === 0
          ? envFs.allowWorkspaceRoot !== false
          : envReadPaths.some((envPattern) =>
              matchesPathPattern(canonPath, envPattern, workspaceRoot),
            );

      if (permitted) {
        grantReadPaths.push(canonPath);
      } else {
        violations.push({
          code: "FS_PATH_EXPANSION",
          subsystem: "fs",
          message: `Requested read path '${rawPath}' exceeds workspace envelope allowed read paths`,
          requestedValue: rawPath,
          allowedValue: envReadPaths,
        });
      }
    } catch (err) {
      violations.push({
        code: "FS_TRAVERSAL_DETECTED",
        subsystem: "fs",
        message: `Invalid or escaping read path '${rawPath}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: rawPath,
      });
    }
  }

  // Write Paths intersection
  const grantWritePaths: string[] = [];
  const reqWritePaths = reqFs.writePaths ?? [];
  const envWritePaths = envFs.writePaths ?? [];

  for (const rawPath of reqWritePaths) {
    try {
      const canonPath = canonicalizePath(rawPath, workspaceRoot, {
        allowTemp,
        allowGlob: true,
      });

      const isDenied = allDenyPaths.some((d) => matchesPathPattern(canonPath, d, workspaceRoot));
      if (isDenied) {
        violations.push({
          code: "FS_WRITE_PATH_EXPANSION",
          subsystem: "fs",
          message: `Write path ${rawPath} is explicitly denied by policy`,
          requestedValue: rawPath,
        });
        continue;
      }

      const permitted =
        envWritePaths.length === 0
          ? false // Write requires explicit authorization
          : envWritePaths.some((envPattern) =>
              matchesPathPattern(canonPath, envPattern, workspaceRoot),
            );

      if (permitted) {
        grantWritePaths.push(canonPath);
      } else {
        violations.push({
          code: "FS_WRITE_PATH_EXPANSION",
          subsystem: "fs",
          message: `Requested write path '${rawPath}' exceeds workspace envelope allowed write paths`,
          requestedValue: rawPath,
          allowedValue: envWritePaths,
        });
      }
    } catch (err) {
      violations.push({
        code: "FS_TRAVERSAL_DETECTED",
        subsystem: "fs",
        message: `Invalid or escaping write path '${rawPath}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: rawPath,
      });
    }
  }

  // Max File Size: minimum of requested and envelope limits
  const reqMaxFileSize = reqFs.maxFileSizeBytes ?? 10485760;
  const envMaxFileSize = envFs.maxFileSizeBytes ?? 10485760;
  const grantMaxFileSize = Math.min(reqMaxFileSize, envMaxFileSize);

  if (reqMaxFileSize > envMaxFileSize) {
    violations.push({
      code: "FS_MAX_FILE_SIZE_EXPANSION",
      subsystem: "fs",
      message: `Requested maxFileSizeBytes (${reqMaxFileSize}) exceeds envelope limit (${envMaxFileSize})`,
      requestedValue: reqMaxFileSize,
      allowedValue: envMaxFileSize,
    });
  }

  const grantedFs: FsCapability = {
    readPaths: Array.from(new Set(grantReadPaths)).sort(),
    writePaths: Array.from(new Set(grantWritePaths)).sort(),
    allowWorkspaceRoot,
    allowTemp,
    denyPaths: allDenyPaths,
    maxFileSizeBytes: grantMaxFileSize,
  };

  // ===========================================================================
  // 2. Network Subsystem Intersection
  // ===========================================================================
  const reqNet: NetCapability = requested.net ?? {};
  const envNet: NetCapability = envelope.net ?? {};

  const allowOutbound = Boolean(reqNet.allowOutbound && envNet.allowOutbound);
  if (reqNet.allowOutbound && !envNet.allowOutbound) {
    violations.push({
      code: "NET_OUTBOUND_FORBIDDEN",
      subsystem: "net",
      message:
        "Tool requested outbound network access, but workspace envelope forbids all outbound network",
      requestedValue: true,
      allowedValue: false,
    });
  }

  const allowLocalhost = Boolean(reqNet.allowLocalhost && envNet.allowLocalhost);
  if (reqNet.allowLocalhost && !envNet.allowLocalhost) {
    violations.push({
      code: "NET_LOCALHOST_FORBIDDEN",
      subsystem: "net",
      message: "Tool requested localhost network access, but workspace envelope forbids localhost",
      requestedValue: true,
      allowedValue: false,
    });
  }

  // Deny private ranges is more restrictive (true if either is true)
  const denyPrivateRanges =
    reqNet.denyPrivateRanges !== false || envNet.denyPrivateRanges !== false;

  // Allowed Domains intersection
  const grantDomains: string[] = [];
  const reqDomains = reqNet.allowedDomains ?? [];
  const envDomains = envNet.allowedDomains ?? [];

  for (const domain of reqDomains) {
    try {
      const canonDomain = canonicalizeHost(domain);

      if (denyPrivateRanges && isPrivateOrReservedIp(canonDomain)) {
        violations.push({
          code: "NET_PRIVATE_IP_BLOCKED",
          subsystem: "net",
          message: `Domain/host '${domain}' is a private, loopback, or reserved IP address`,
          requestedValue: domain,
        });
        continue;
      }

      const permitted =
        envDomains.length === 0
          ? envNet.allowOutbound === true
          : envDomains.some((envDom) => matchesHostPattern(canonDomain, envDom));

      if (permitted) {
        grantDomains.push(canonDomain);
      } else {
        violations.push({
          code: "NET_DOMAIN_EXPANSION",
          subsystem: "net",
          message: `Requested domain '${domain}' is not authorized in workspace envelope`,
          requestedValue: domain,
          allowedValue: envDomains,
        });
      }
    } catch (err) {
      violations.push({
        code: "NET_DOMAIN_EXPANSION",
        subsystem: "net",
        message: `Invalid domain '${domain}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: domain,
      });
    }
  }

  // Allowed Hosts intersection
  const grantHosts: string[] = [];
  const reqHosts = reqNet.allowedHosts ?? [];
  const envHosts = envNet.allowedHosts ?? [];

  for (const host of reqHosts) {
    try {
      const canonHost = canonicalizeHost(host);

      if (denyPrivateRanges && isPrivateOrReservedIp(canonHost)) {
        violations.push({
          code: "NET_PRIVATE_IP_BLOCKED",
          subsystem: "net",
          message: `Host '${host}' resolves to private/reserved IP`,
          requestedValue: host,
        });
        continue;
      }

      const permitted =
        envHosts.length === 0
          ? envNet.allowOutbound === true
          : envHosts.some((envH) => matchesHostPattern(canonHost, envH));

      if (permitted) {
        grantHosts.push(canonHost);
      } else {
        violations.push({
          code: "NET_HOST_EXPANSION",
          subsystem: "net",
          message: `Requested host '${host}' is not authorized in workspace envelope`,
          requestedValue: host,
          allowedValue: envHosts,
        });
      }
    } catch (err) {
      violations.push({
        code: "NET_HOST_EXPANSION",
        subsystem: "net",
        message: `Invalid host '${host}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: host,
      });
    }
  }

  // Allowed Ports intersection
  const reqPorts = (reqNet.allowedPorts ?? []).map((p) => canonicalizePort(p));
  const envPorts = (envNet.allowedPorts ?? []).map((p) => canonicalizePort(p));
  let grantPorts: number[] = [];

  if (envPorts.length === 0) {
    // If envelope has no port restriction, grant requested ports
    grantPorts = reqPorts;
  } else {
    for (const p of reqPorts) {
      if (envPorts.includes(p)) {
        grantPorts.push(p);
      } else {
        violations.push({
          code: "NET_PORT_EXPANSION",
          subsystem: "net",
          message: `Requested network port ${p} is not authorized in envelope allowed ports`,
          requestedValue: p,
          allowedValue: envPorts,
        });
      }
    }
  }

  // Allowed Protocols intersection
  const reqProtocols = (reqNet.allowedProtocols ?? ["https"]).map(canonicalizeScheme);
  const envProtocols = (envNet.allowedProtocols ?? ["https"]).map(canonicalizeScheme);
  const grantProtocols: ("http" | "https" | "ws" | "wss")[] = [];

  for (const proto of reqProtocols) {
    if (envProtocols.includes(proto)) {
      grantProtocols.push(proto);
    } else {
      violations.push({
        code: "NET_PROTOCOL_EXPANSION",
        subsystem: "net",
        message: `Requested protocol scheme '${proto}' is not authorized in envelope`,
        requestedValue: proto,
        allowedValue: envProtocols,
      });
    }
  }

  const grantedNet: NetCapability = {
    allowOutbound,
    allowedDomains: Array.from(new Set(grantDomains)).sort(),
    allowedHosts: Array.from(new Set(grantHosts)).sort(),
    allowedPorts: Array.from(new Set(grantPorts)).sort((a, b) => a - b),
    allowedProtocols: Array.from(new Set(grantProtocols)).sort(),
    allowLocalhost,
    denyPrivateRanges,
  };

  // ===========================================================================
  // 3. Command Subsystem Intersection
  // ===========================================================================
  const reqCmd: CommandCapability = requested.command ?? {};
  const envCmd: CommandCapability = envelope.command ?? {};

  const allowShellExecution = Boolean(reqCmd.allowShellExecution && envCmd.allowShellExecution);
  if (reqCmd.allowShellExecution && !envCmd.allowShellExecution) {
    violations.push({
      code: "CMD_SHELL_FORBIDDEN",
      subsystem: "command",
      message: "Tool requested shell execution, but workspace envelope forbids shell execution",
      requestedValue: true,
      allowedValue: false,
    });
  }

  // Forbidden patterns: union (cumulative)
  const forbiddenPatterns = Array.from(
    new Set([...(reqCmd.forbiddenPatterns ?? []), ...(envCmd.forbiddenPatterns ?? [])]),
  ).sort();

  // Allowed Commands intersection
  const reqCommands = reqCmd.allowedCommands ?? [];
  const envCommands = envCmd.allowedCommands ?? [];
  const grantCommands: string[] = [];

  for (const cmd of reqCommands) {
    try {
      const canonCmd = canonicalizeCommand(cmd);

      // Check against forbidden patterns
      const isForbidden = forbiddenPatterns.some((pat) => canonCmd.includes(pat));
      if (isForbidden) {
        violations.push({
          code: "CMD_FORBIDDEN_PATTERN_VIOLATION",
          subsystem: "command",
          message: `Command '${cmd}' matches a forbidden execution pattern`,
          requestedValue: cmd,
        });
        continue;
      }

      const permitted =
        envCommands.length === 0
          ? false // Subprocess execution requires explicit command authorization
          : envCommands.some((c) => canonicalizeCommand(c) === canonCmd);

      if (permitted) {
        grantCommands.push(canonCmd);
      } else {
        violations.push({
          code: "CMD_COMMAND_EXPANSION",
          subsystem: "command",
          message: `Command '${cmd}' is not authorized in workspace envelope`,
          requestedValue: cmd,
          allowedValue: envCommands,
        });
      }
    } catch (err) {
      violations.push({
        code: "CMD_COMMAND_EXPANSION",
        subsystem: "command",
        message: `Invalid command '${cmd}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: cmd,
      });
    }
  }

  // Allowed Binaries intersection
  const reqBinaries = reqCmd.allowedBinaries ?? [];
  const envBinaries = envCmd.allowedBinaries ?? [];
  const grantBinaries: string[] = [];

  for (const bin of reqBinaries) {
    try {
      const canonBin = canonicalizeCommand(bin);

      const permitted =
        envBinaries.length === 0
          ? false
          : envBinaries.some((b) => canonicalizeCommand(b) === canonBin);

      if (permitted) {
        grantBinaries.push(canonBin);
      } else {
        violations.push({
          code: "CMD_BINARY_EXPANSION",
          subsystem: "command",
          message: `Binary '${bin}' is not authorized in workspace envelope`,
          requestedValue: bin,
          allowedValue: envBinaries,
        });
      }
    } catch (err) {
      violations.push({
        code: "CMD_BINARY_EXPANSION",
        subsystem: "command",
        message: `Invalid binary '${bin}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: bin,
      });
    }
  }

  // Environment Passthrough intersection
  const reqEnv = reqCmd.allowEnvPassthrough ?? [];
  const envEnv = envCmd.allowEnvPassthrough ?? [];
  const grantEnv: string[] = [];

  for (const envVar of reqEnv) {
    try {
      const canonEnv = canonicalizeEnvName(envVar);
      if (isDangerousEnvVar(canonEnv)) {
        violations.push({
          code: "CMD_ENV_EXPANSION",
          subsystem: "command",
          message: `Environment variable '${envVar}' is dangerous and prohibited from passthrough`,
          requestedValue: envVar,
        });
        continue;
      }

      if (envEnv.includes(canonEnv)) {
        grantEnv.push(canonEnv);
      } else {
        violations.push({
          code: "CMD_ENV_EXPANSION",
          subsystem: "command",
          message: `Environment variable '${envVar}' is not authorized in envelope passthrough list`,
          requestedValue: envVar,
          allowedValue: envEnv,
        });
      }
    } catch (err) {
      violations.push({
        code: "CMD_ENV_EXPANSION",
        subsystem: "command",
        message: `Invalid env variable name '${envVar}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: envVar,
      });
    }
  }

  const grantedCmd: CommandCapability = {
    allowShellExecution,
    allowedCommands: Array.from(new Set(grantCommands)).sort(),
    allowedBinaries: Array.from(new Set(grantBinaries)).sort(),
    forbiddenPatterns,
    allowEnvPassthrough: Array.from(new Set(grantEnv)).sort(),
  };

  // ===========================================================================
  // 4. Secrets Subsystem Intersection
  // ===========================================================================
  const reqSec: SecretCapability = requested.secrets ?? {};
  const envSec: SecretCapability = envelope.secrets ?? {};

  // Direct Read denial is cumulative (true if either denies)
  const denyDirectRead = reqSec.denyDirectRead !== false || envSec.denyDirectRead !== false;
  if (!reqSec.denyDirectRead && envSec.denyDirectRead) {
    violations.push({
      code: "SECRET_DIRECT_READ_FORBIDDEN",
      subsystem: "secrets",
      message: "Tool requested direct read of secrets, but envelope requires denyDirectRead",
      requestedValue: false,
      allowedValue: true,
    });
  }

  const injectAsEnv = Boolean(reqSec.injectAsEnv && envSec.injectAsEnv !== false);

  // Allowed Secret Names intersection
  const reqSecretNames = reqSec.allowedSecretNames ?? [];
  const envSecretNames = envSec.allowedSecretNames ?? [];
  const envSecretPrefixes = envSec.allowedPrefixes ?? [];
  const grantSecretNames: string[] = [];

  for (const name of reqSecretNames) {
    try {
      const canonName = canonicalizeSecretName(name);

      if (isSecretAllowed(canonName, envSecretNames, envSecretPrefixes)) {
        grantSecretNames.push(canonName);
      } else {
        violations.push({
          code: "SECRET_NAME_EXPANSION",
          subsystem: "secrets",
          message: `Secret alias '${name}' is not authorized by workspace envelope`,
          requestedValue: name,
          allowedValue: { names: envSecretNames, prefixes: envSecretPrefixes },
        });
      }
    } catch (err) {
      violations.push({
        code: "SECRET_NAME_EXPANSION",
        subsystem: "secrets",
        message: `Invalid secret name '${name}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: name,
      });
    }
  }

  // Allowed Prefixes intersection
  const reqSecretPrefixes = reqSec.allowedPrefixes ?? [];
  const grantSecretPrefixes: string[] = [];

  for (const prefix of reqSecretPrefixes) {
    try {
      const canonPrefix = canonicalizeSecretPrefix(prefix);

      const permitted = envSecretPrefixes.some(
        (envP) => canonPrefix === envP || canonPrefix.startsWith(envP),
      );

      if (permitted) {
        grantSecretPrefixes.push(canonPrefix);
      } else {
        violations.push({
          code: "SECRET_PREFIX_EXPANSION",
          subsystem: "secrets",
          message: `Secret prefix '${prefix}' is not authorized by workspace envelope`,
          requestedValue: prefix,
          allowedValue: envSecretPrefixes,
        });
      }
    } catch (err) {
      violations.push({
        code: "SECRET_PREFIX_EXPANSION",
        subsystem: "secrets",
        message: `Invalid secret prefix '${prefix}': ${err instanceof Error ? err.message : String(err)}`,
        requestedValue: prefix,
      });
    }
  }

  const grantedSec: SecretCapability = {
    allowedSecretNames: Array.from(new Set(grantSecretNames)).sort(),
    allowedPrefixes: Array.from(new Set(grantSecretPrefixes)).sort(),
    denyDirectRead,
    injectAsEnv,
  };

  // ===========================================================================
  // 5. Limits Intersection
  // ===========================================================================
  const reqLim: CapabilityLimits = requested.limits ?? {
    maxConcurrentExecutions: 4,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 128,
    maxExecutionTimeMs: 30000,
    maxOutputSizeBytes: 1048576,
  };

  const envLim: CapabilityLimits = envelope.limits ?? {
    maxConcurrentExecutions: 4,
    maxCpuUsagePercent: 100,
    maxMemoryMb: 128,
    maxExecutionTimeMs: 30000,
    maxOutputSizeBytes: 1048576,
  };

  const grantedLimits: CapabilityLimits = {
    maxConcurrentExecutions: Math.min(
      reqLim.maxConcurrentExecutions ?? 4,
      envLim.maxConcurrentExecutions ?? 4,
    ),
    maxCpuUsagePercent: Math.min(
      reqLim.maxCpuUsagePercent ?? 100,
      envLim.maxCpuUsagePercent ?? 100,
    ),
    maxMemoryMb: Math.min(reqLim.maxMemoryMb ?? 128, envLim.maxMemoryMb ?? 128),
    maxExecutionTimeMs: Math.min(
      reqLim.maxExecutionTimeMs ?? 30000,
      envLim.maxExecutionTimeMs ?? 30000,
    ),
    maxOutputSizeBytes: Math.min(
      reqLim.maxOutputSizeBytes ?? 1048576,
      envLim.maxOutputSizeBytes ?? 1048576,
    ),
  };

  if ((reqLim.maxMemoryMb ?? 128) > (envLim.maxMemoryMb ?? 128)) {
    violations.push({
      code: "LIMIT_EXPANSION",
      subsystem: "limits",
      message: `Requested maxMemoryMb (${reqLim.maxMemoryMb}) exceeds envelope limit (${envLim.maxMemoryMb})`,
      requestedValue: reqLim.maxMemoryMb,
      allowedValue: envLim.maxMemoryMb,
    });
  }

  if ((reqLim.maxExecutionTimeMs ?? 30000) > (envLim.maxExecutionTimeMs ?? 30000)) {
    violations.push({
      code: "LIMIT_EXPANSION",
      subsystem: "limits",
      message: `Requested maxExecutionTimeMs (${reqLim.maxExecutionTimeMs}) exceeds envelope limit (${envLim.maxExecutionTimeMs})`,
      requestedValue: reqLim.maxExecutionTimeMs,
      allowedValue: envLim.maxExecutionTimeMs,
    });
  }

  const grantCapabilities: CapabilityManifest = {
    manifestId: requested.manifestId,
    fs: grantedFs,
    net: grantedNet,
    command: grantedCmd,
    secrets: grantedSec,
    limits: grantedLimits,
  };

  const expansionAttempted = violations.length > 0;
  const isExactSubset = violations.length === 0;

  return {
    grantCapabilities,
    isExactSubset,
    expansionAttempted,
    violations,
  };
}
