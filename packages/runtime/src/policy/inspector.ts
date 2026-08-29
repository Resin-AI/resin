import type {
  CapabilityEnvelope,
  CapabilityLimits,
  CapabilityManifest,
  CommandCapability,
  FsCapability,
  NetCapability,
  SecretCapability,
  ToolManifest,
} from "@resin/contracts";
import type { PolicyEvaluationResult } from "./engine.js";
import {
  type CapabilityIntersectionResult,
  type PolicyViolation,
  intersectCapabilities,
} from "./intersection.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskAssessment {
  riskLevel: RiskLevel;
  riskFactors: string[];
  warnings: string[];
}

export interface PolicyInspectionResult {
  status: "APPROVED" | "EXPANSION_REQUIRED" | "DENIED";
  riskLevel: RiskLevel;
  riskFactors: string[];
  warnings: string[];
  grantedCapabilities: CapabilityManifest;
  requestedCapabilities: CapabilityManifest;
  envelopeCapabilities: CapabilityEnvelope;
  violations: PolicyViolation[];
  remediationCommands: string[];
}
export interface PolicyInspectOptions {
  workspaceRoot?: string;
}

/**
 * Assesses the security risk level and identifies risk factors for a capability request.
 */
export function assessRiskLevel(
  manifest: CapabilityManifest,
  violations: PolicyViolation[] = [],
): RiskAssessment {
  const warnings: string[] = [];
  const riskFactors: string[] = [];

  const cmd: CommandCapability = manifest.command ?? {};
  const fs: FsCapability = manifest.fs ?? {};
  const net: NetCapability = manifest.net ?? {};
  const sec: SecretCapability = manifest.secrets ?? {};

  // CRITICAL RISK CHECKS
  if (cmd.allowShellExecution) {
    riskFactors.push("Shell execution is enabled, allowing arbitrary shell command execution.");
  }

  if (sec.denyDirectRead === false) {
    riskFactors.push("Direct read of sensitive environment secrets is permitted.");
  }

  if (net.denyPrivateRanges === false || net.allowLocalhost) {
    riskFactors.push("Network access to private IP ranges or localhost is permitted.");
  }

  // HIGH RISK CHECKS
  if ((fs.writePaths ?? []).length > 0) {
    riskFactors.push(
      `File write access requested for ${(fs.writePaths ?? []).length} path patterns.`,
    );
  }

  if ((cmd.allowedCommands ?? []).length > 0 || (cmd.allowedBinaries ?? []).length > 0) {
    riskFactors.push("Subprocess execution of external binaries is requested.");
  }

  if (net.allowOutbound && (net.allowedDomains ?? []).length === 0) {
    warnings.push("Outbound network is enabled without domain restriction.");
  }

  // MEDIUM RISK CHECKS
  if ((fs.readPaths ?? []).length > 10) {
    warnings.push(`Extensive file read access requested (${(fs.readPaths ?? []).length} paths).`);
  }

  if ((sec.allowedSecretNames ?? []).length > 0) {
    warnings.push(
      `Access requested for named secrets: ${(sec.allowedSecretNames ?? []).join(", ")}`,
    );
  }

  // Compute Risk Level
  let riskLevel: RiskLevel = "LOW";
  if (
    cmd.allowShellExecution ||
    sec.denyDirectRead === false ||
    net.denyPrivateRanges === false ||
    violations.some(
      (v) => v.code === "NET_PRIVATE_IP_BLOCKED" || v.code === "FS_TRAVERSAL_DETECTED",
    )
  ) {
    riskLevel = "CRITICAL";
  } else if (
    (fs.writePaths ?? []).length > 0 ||
    (cmd.allowedCommands ?? []).length > 0 ||
    net.allowOutbound
  ) {
    riskLevel = "HIGH";
  } else if ((fs.readPaths ?? []).length > 10 || (sec.allowedSecretNames ?? []).length > 0) {
    riskLevel = "MEDIUM";
  }

  return { riskLevel, riskFactors, warnings };
}

/**
 * Generates actionable CLI commands for envelope expansion based on policy violations.
 */
export function generateRemediationCommands(violations: PolicyViolation[]): string[] {
  const commands: string[] = [];
  const addedDomains = new Set<string>();
  const addedReadPaths = new Set<string>();
  const addedWritePaths = new Set<string>();
  const addedCommands = new Set<string>();
  const addedSecrets = new Set<string>();

  for (const violation of violations) {
    switch (violation.code) {
      case "NET_OUTBOUND_FORBIDDEN":
        commands.push("resin envelope expand --allow-outbound");
        break;
      case "NET_DOMAIN_EXPANSION":
      case "NET_HOST_EXPANSION":
        if (
          String(violation.requestedValue) === violation.requestedValue &&
          !addedDomains.has(violation.requestedValue)
        ) {
          addedDomains.add(violation.requestedValue);
          commands.push(`resin envelope expand --add-domain ${violation.requestedValue}`);
        }
        break;
      case "NET_LOCALHOST_FORBIDDEN":
        commands.push("resin envelope expand --allow-localhost");
        break;
      case "FS_PATH_EXPANSION":
        if (
          String(violation.requestedValue) === violation.requestedValue &&
          !addedReadPaths.has(violation.requestedValue)
        ) {
          addedReadPaths.add(violation.requestedValue);
          commands.push(`resin envelope expand --add-read-path "${violation.requestedValue}"`);
        }
        break;
      case "FS_WRITE_PATH_EXPANSION":
        if (
          String(violation.requestedValue) === violation.requestedValue &&
          !addedWritePaths.has(violation.requestedValue)
        ) {
          addedWritePaths.add(violation.requestedValue);
          commands.push(`resin envelope expand --add-write-path "${violation.requestedValue}"`);
        }
        break;
      case "CMD_SHELL_FORBIDDEN":
        commands.push("resin envelope expand --allow-shell");
        break;
      case "CMD_COMMAND_EXPANSION":
      case "CMD_BINARY_EXPANSION":
        if (
          String(violation.requestedValue) === violation.requestedValue &&
          !addedCommands.has(violation.requestedValue)
        ) {
          addedCommands.add(violation.requestedValue);
          commands.push(`resin envelope expand --add-command ${violation.requestedValue}`);
        }
        break;
      case "SECRET_NAME_EXPANSION":
        if (
          String(violation.requestedValue) === violation.requestedValue &&
          !addedSecrets.has(violation.requestedValue)
        ) {
          addedSecrets.add(violation.requestedValue);
          commands.push(`resin envelope expand --add-secret ${violation.requestedValue}`);
        }
        break;
      case "SECRET_PREFIX_EXPANSION":
        if (String(violation.requestedValue) === violation.requestedValue) {
          commands.push(`resin envelope expand --add-secret-prefix ${violation.requestedValue}`);
        }
        break;
      default:
        break;
    }
  }

  return commands;
}

/**
 * Inspects a tool capability request against a workspace envelope.
 */
export function inspectPolicy(
  manifestOrTool: ToolManifest | CapabilityManifest,
  envelope: CapabilityEnvelope,
  options: PolicyInspectOptions = {},
): PolicyInspectionResult {
  const requestedCapabilities: CapabilityManifest =
    "capabilities" in manifestOrTool ? manifestOrTool.capabilities : manifestOrTool;

  const intersection = intersectCapabilities(requestedCapabilities, envelope, {
    workspaceRoot: options.workspaceRoot,
  });

  const { riskLevel, riskFactors, warnings } = assessRiskLevel(
    requestedCapabilities,
    intersection.violations,
  );

  const remediationCommands = generateRemediationCommands(intersection.violations);

  let status: "APPROVED" | "EXPANSION_REQUIRED" | "DENIED" = "APPROVED";
  if (envelope.isFrozen && intersection.expansionAttempted) {
    status = "DENIED";
  } else if (intersection.expansionAttempted) {
    status = "EXPANSION_REQUIRED";
  }

  return {
    status,
    riskLevel,
    riskFactors,
    warnings,
    grantedCapabilities: intersection.grantCapabilities,
    requestedCapabilities,
    envelopeCapabilities: envelope,
    violations: intersection.violations,
    remediationCommands,
  };
}

// =============================================================================
// Capability Diff API
// =============================================================================

export interface CapabilityDiff {
  hasChanges: boolean;
  isBroadening: boolean;
  added: Record<string, unknown[]>;
  removed: Record<string, unknown[]>;
  modified: Record<string, { before: unknown; after: unknown }>;
}

/**
 * Computes structured diff between two capability manifests or envelopes.
 */
export function diffCapabilities(
  source: CapabilityManifest | CapabilityEnvelope,
  target: CapabilityManifest | CapabilityEnvelope,
): CapabilityDiff {
  const added: Record<string, unknown[]> = {};
  const removed: Record<string, unknown[]> = {};
  const modified: Record<string, { before: unknown; after: unknown }> = {};
  let isBroadening = false;

  const compareArrays = (
    key: string,
    arr1: unknown[] = [],
    arr2: unknown[] = [],
    broadeningWhenAdded = true,
  ) => {
    const s1 = new Set(arr1.map((x) => JSON.stringify(x)));
    const s2 = new Set(arr2.map((x) => JSON.stringify(x)));

    const inAdded = arr2.filter((x) => !s1.has(JSON.stringify(x)));
    const inRemoved = arr1.filter((x) => !s2.has(JSON.stringify(x)));

    if (inAdded.length > 0) {
      added[key] = inAdded;
      if (broadeningWhenAdded) isBroadening = true;
    }
    if (inRemoved.length > 0) {
      removed[key] = inRemoved;
      if (!broadeningWhenAdded) isBroadening = true;
    }
  };

  const compareBooleans = (
    key: string,
    b1: boolean | undefined,
    b2: boolean | undefined,
    broadeningWhenTrue = true,
  ) => {
    const val1 = Boolean(b1);
    const val2 = Boolean(b2);
    if (val1 !== val2) {
      modified[key] = { before: val1, after: val2 };
      if (broadeningWhenTrue && val2 && !val1) isBroadening = true;
      if (!broadeningWhenTrue && !val2 && val1) isBroadening = true;
    }
  };

  const compareNumbers = (key: string, n1: number | undefined, n2: number | undefined) => {
    if (n1 !== n2 && n1 !== undefined && n2 !== undefined) {
      modified[key] = { before: n1, after: n2 };
      if (n2 > n1) isBroadening = true;
    }
  };

  // Filesystem
  compareArrays("fs.readPaths", source.fs?.readPaths, target.fs?.readPaths, true);
  compareArrays("fs.writePaths", source.fs?.writePaths, target.fs?.writePaths, true);
  compareArrays("fs.denyPaths", source.fs?.denyPaths, target.fs?.denyPaths, false);
  compareBooleans(
    "fs.allowWorkspaceRoot",
    source.fs?.allowWorkspaceRoot,
    target.fs?.allowWorkspaceRoot,
    true,
  );
  compareBooleans("fs.allowTemp", source.fs?.allowTemp, target.fs?.allowTemp, true);
  compareNumbers("fs.maxFileSizeBytes", source.fs?.maxFileSizeBytes, target.fs?.maxFileSizeBytes);

  // Network
  compareBooleans("net.allowOutbound", source.net?.allowOutbound, target.net?.allowOutbound, true);
  compareBooleans(
    "net.allowLocalhost",
    source.net?.allowLocalhost,
    target.net?.allowLocalhost,
    true,
  );
  compareBooleans(
    "net.denyPrivateRanges",
    source.net?.denyPrivateRanges,
    target.net?.denyPrivateRanges,
    false,
  );
  compareArrays("net.allowedDomains", source.net?.allowedDomains, target.net?.allowedDomains, true);
  compareArrays("net.allowedHosts", source.net?.allowedHosts, target.net?.allowedHosts, true);
  compareArrays("net.allowedPorts", source.net?.allowedPorts, target.net?.allowedPorts, true);
  compareArrays(
    "net.allowedProtocols",
    source.net?.allowedProtocols,
    target.net?.allowedProtocols,
    true,
  );

  // Command
  compareBooleans(
    "command.allowShellExecution",
    source.command?.allowShellExecution,
    target.command?.allowShellExecution,
    true,
  );
  compareArrays(
    "command.allowedCommands",
    source.command?.allowedCommands,
    target.command?.allowedCommands,
    true,
  );
  compareArrays(
    "command.allowedBinaries",
    source.command?.allowedBinaries,
    target.command?.allowedBinaries,
    true,
  );
  compareArrays(
    "command.forbiddenPatterns",
    source.command?.forbiddenPatterns,
    target.command?.forbiddenPatterns,
    false,
  );
  compareArrays(
    "command.allowEnvPassthrough",
    source.command?.allowEnvPassthrough,
    target.command?.allowEnvPassthrough,
    true,
  );

  // Secrets
  compareArrays(
    "secrets.allowedSecretNames",
    source.secrets?.allowedSecretNames,
    target.secrets?.allowedSecretNames,
    true,
  );
  compareArrays(
    "secrets.allowedPrefixes",
    source.secrets?.allowedPrefixes,
    target.secrets?.allowedPrefixes,
    true,
  );
  compareBooleans(
    "secrets.denyDirectRead",
    source.secrets?.denyDirectRead,
    target.secrets?.denyDirectRead,
    false,
  );
  compareBooleans(
    "secrets.injectAsEnv",
    source.secrets?.injectAsEnv,
    target.secrets?.injectAsEnv,
    true,
  );

  // Limits
  compareNumbers("limits.maxMemoryMb", source.limits?.maxMemoryMb, target.limits?.maxMemoryMb);
  compareNumbers(
    "limits.maxExecutionTimeMs",
    source.limits?.maxExecutionTimeMs,
    target.limits?.maxExecutionTimeMs,
  );
  compareNumbers(
    "limits.maxOutputSizeBytes",
    source.limits?.maxOutputSizeBytes,
    target.limits?.maxOutputSizeBytes,
  );

  const hasChanges =
    Object.keys(added).length > 0 ||
    Object.keys(removed).length > 0 ||
    Object.keys(modified).length > 0;

  return {
    hasChanges,
    isBroadening,
    added,
    removed,
    modified,
  };
}

// =============================================================================
// Denial Explanation API
// =============================================================================

export interface DenialExplanation {
  summary: string;
  primaryReason: string;
  violations: PolicyViolation[];
  remediationCommands: string[];
}

/**
 * Generates human-readable explanation and CLI remediation advice for an evaluation denial.
 */
export function explainDenial(
  resultOrViolations: PolicyEvaluationResult | PolicyViolation[],
): DenialExplanation {
  const violations = Array.isArray(resultOrViolations)
    ? resultOrViolations
    : resultOrViolations.allowed === false
      ? resultOrViolations.violations
      : [];

  const primaryReason = Array.isArray(resultOrViolations)
    ? (violations[0]?.message ?? "Capability request was denied by policy")
    : resultOrViolations.allowed === false
      ? resultOrViolations.reason
      : "No violations detected";

  const remediationCommands = generateRemediationCommands(violations);

  const summary =
    violations.length === 0
      ? primaryReason
      : `${primaryReason}. Found ${violations.length} policy violation(s).`;

  return {
    summary,
    primaryReason,
    violations,
    remediationCommands,
  };
}
