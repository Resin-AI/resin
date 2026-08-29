import { createHash } from "node:crypto";
import {
  type CapabilityEnvelope,
  CapabilityEnvelopeSchema,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  hashCanonicalContent,
} from "@resin/contracts";
import type { ValidationResult } from "./types.js";
const VALID_RUNTIMES: Record<string, true> = {
  node: true,
  deno: true,
  quickjs: true,
  docker: true,
  wasm: true,
  browser: true,
  python: true,
  shell: true,
  builtin: true,
};
const DANGEROUS_COMMANDS: Record<string, true> = {
  "rm -rf /": true,
  sudo: true,
  su: true,
  mkfs: true,
  dd: true,
  shutdown: true,
  reboot: true,
  ":(){ :|:& };:": true,
};

/**
 * Computes SHA-256 hex digest of string content.
 */
export function computeSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Computes the canonical digest of a tool manifest.
 */
export function computeManifestDigest(manifest: ToolManifest | Record<string, unknown>): string {
  // Strip existing digest for deterministic computation
  const { digest: _, ...rest } = manifest as Record<string, unknown>;
  const parsed = ToolManifestSchema.omit({ digest: true }).safeParse(rest);
  const normalized = parsed.success ? parsed.data : rest;
  return hashCanonicalContent(normalized);
}
/**
 * Validates a tool manifest, its artifact, and compliance with the workspace capability envelope.
 */
export function validateToolStaging(
  rawManifest: unknown,
  rawArtifact?: unknown,
  rawEnvelope?: CapabilityEnvelope,
  options?: {
    existingVersions?: ToolVersion[];
  },
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let calculatedManifestDigest: string | undefined;
  let calculatedArtifactDigest: string | undefined;

  // 1. Manifest Schema Validation
  const manifestParse = ToolManifestSchema.safeParse(rawManifest);
  if (!manifestParse.success) {
    for (const issue of manifestParse.error.issues) {
      errors.push(`Manifest schema error at '${issue.path.join(".")}': ${issue.message}`);
    }
    return { valid: false, errors, warnings };
  }

  const manifest = manifestParse.data;

  // 2. Digest Verification
  calculatedManifestDigest = computeManifestDigest(manifest);
  if (manifest.digest && manifest.digest !== calculatedManifestDigest) {
    errors.push(
      `Manifest digest mismatch: declared '${manifest.digest}' but computed '${calculatedManifestDigest}'`,
    );
  }

  // 3. Artifact Validation (if provided)
  if (rawArtifact !== undefined) {
    const artifactParse = ToolArtifactSchema.safeParse(rawArtifact);
    if (!artifactParse.success) {
      for (const issue of artifactParse.error.issues) {
        errors.push(`Artifact schema error at '${issue.path.join(".")}': ${issue.message}`);
      }
    } else {
      const artifact = artifactParse.data;
      calculatedArtifactDigest = artifact.artifactDigest;
      if (artifact.sourceCode && artifact.bundleReference?.format === "embedded") {
        const codeHash = computeSha256(artifact.sourceCode);
        if (artifact.bundleReference.hash !== codeHash) {
          errors.push(
            `Artifact hash mismatch: declared '${artifact.bundleReference.hash}' but computed '${codeHash}'`,
          );
        }
      }
    }
  }

  // 4. Runtime Validation
  if (manifest.runtime) {
    const runtime = manifest.runtime.runtime?.toLowerCase();
    if (!runtime || !VALID_RUNTIMES[runtime]) {
      errors.push(
        `Unsupported runtime engine '${manifest.runtime.runtime}'. Supported: node, deno, quickjs, docker, wasm, browser, python, shell, builtin`,
      );
    }

    if (manifest.runtime.timeoutMs !== undefined && manifest.runtime.timeoutMs <= 0) {
      errors.push(
        `Tool execution timeoutMs must be positive, received: ${manifest.runtime.timeoutMs}`,
      );
    }
    if (manifest.runtime.timeoutMs !== undefined && manifest.runtime.timeoutMs > 300_000) {
      errors.push(
        `Tool execution timeoutMs exceeds maximum allowable 300,000ms: ${manifest.runtime.timeoutMs}`,
      );
    }
  }
  // 5. Capability Envelope Validation
  if (rawEnvelope) {
    const envelopeParse = CapabilityEnvelopeSchema.safeParse(rawEnvelope);
    if (!envelopeParse.success) {
      warnings.push("Supplied capability envelope is malformed; defaulting to strict validation");
    } else {
      const envelope = envelopeParse.data;

      if (envelope.isFrozen) {
        const hasFs =
          manifest.capabilities?.fs &&
          ((manifest.capabilities.fs.readPaths?.length ?? 0) > 0 ||
            (manifest.capabilities.fs.writePaths?.length ?? 0) > 0);
        const hasNet =
          manifest.capabilities?.net && (manifest.capabilities.net.allowedHosts?.length ?? 0) > 0;
        const hasCmd =
          manifest.capabilities?.command &&
          (manifest.capabilities.command.allowedCommands?.length ?? 0) > 0;

        if (hasFs || hasNet || hasCmd) {
          errors.push(
            "Workspace capability envelope is frozen; cannot stage tool requesting new capabilities",
          );
        }
      }

      // Filesystem Capability checks
      if (manifest.capabilities?.fs && envelope.fs) {
        const manifestFs = manifest.capabilities.fs;
        const envFs = envelope.fs;

        // Path traversal checks
        const checkTraversal = (paths: string[], label: string) => {
          for (const p of paths) {
            if (
              p.includes("..") ||
              p.startsWith("/etc") ||
              p.startsWith("/root") ||
              p.startsWith("/var/run")
            ) {
              errors.push(`Disallowed filesystem traversal or sensitive path in ${label}: '${p}'`);
            }
            if (envFs.denyPaths?.some((denied) => p === denied || p.startsWith(`${denied}/`))) {
              errors.push(`Filesystem path '${p}' violates envelope denyPaths in ${label}`);
            }
          }
        };

        if (manifestFs.writePaths) {
          checkTraversal(manifestFs.writePaths, "writePaths");
          if (envFs.writePaths && envFs.writePaths.length > 0) {
            for (const wp of manifestFs.writePaths) {
              const allowed = envFs.writePaths.some(
                (allowedPrefix) => wp === allowedPrefix || wp.startsWith(`${allowedPrefix}/`),
              );
              if (!allowed) {
                errors.push(
                  `Write path '${wp}' is outside envelope allowed writePaths: [${envFs.writePaths.join(", ")}]`,
                );
              }
            }
          }
        }

        if (manifestFs.readPaths) {
          checkTraversal(manifestFs.readPaths, "readPaths");
        }

        if (
          manifestFs.maxFileSizeBytes &&
          envFs.maxFileSizeBytes &&
          manifestFs.maxFileSizeBytes > envFs.maxFileSizeBytes
        ) {
          errors.push(
            `Tool maxFileSizeBytes (${manifestFs.maxFileSizeBytes}) exceeds capability envelope limit (${envFs.maxFileSizeBytes})`,
          );
        }
      }

      // Network Capability checks
      if (manifest.capabilities?.net && envelope.net) {
        const manifestNet = manifest.capabilities.net;
        const envNet = envelope.net;

        if (manifestNet.allowedHosts) {
          for (const host of manifestNet.allowedHosts) {
            if (
              !envNet.allowLocalhost &&
              (host === "localhost" || host === "127.0.0.1" || host === "::1")
            ) {
              errors.push(`Localhost access is disabled by capability envelope: '${host}'`);
            }
            if (
              envNet.denyPrivateRanges &&
              (host.startsWith("10.") || host.startsWith("192.168.") || host.startsWith("172.16."))
            ) {
              errors.push(`Private network access is disabled by capability envelope: '${host}'`);
            }
            if (envNet.allowedHosts && envNet.allowedHosts.length > 0) {
              const allowed = envNet.allowedHosts.some(
                (allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`),
              );
              if (!allowed) {
                errors.push(`Network host '${host}' is outside capability envelope allowedHosts`);
              }
            }
          }
        }
      }

      // Command Capability checks
      if (manifest.capabilities?.command && envelope.command) {
        const manifestCmd = manifest.capabilities.command;
        const envCmd = envelope.command;

        if (manifestCmd.allowedCommands) {
          for (const cmd of manifestCmd.allowedCommands) {
            if (DANGEROUS_COMMANDS[cmd]) {
              errors.push(`Dangerous system command '${cmd}' is prohibited`);
            }
            if (envCmd.forbiddenPatterns && envCmd.forbiddenPatterns.length > 0) {
              for (const pattern of envCmd.forbiddenPatterns) {
                if (cmd.includes(pattern)) {
                  errors.push(
                    `Command '${cmd}' matches forbiddenPattern '${pattern}' in capability envelope`,
                  );
                }
              }
            }
            if (
              envCmd.allowedCommands &&
              envCmd.allowedCommands.length > 0 &&
              !envCmd.allowedCommands.includes(cmd)
            ) {
              errors.push(`Command '${cmd}' is not in capability envelope allowedCommands`);
            }
          }
        }
      }

      // Resource Limits checks
      if (manifest.limits?.timeoutMs && envelope.limits?.maxExecutionTimeMs) {
        if (manifest.limits.timeoutMs > envelope.limits.maxExecutionTimeMs) {
          errors.push(
            `Tool timeout (${manifest.limits.timeoutMs}ms) exceeds envelope maxExecutionTimeMs (${envelope.limits.maxExecutionTimeMs}ms)`,
          );
        }
      }
      if (manifest.limits?.maxMemoryBytes && envelope.limits?.maxMemoryMb) {
        const envelopeMaxBytes = envelope.limits.maxMemoryMb * 1024 * 1024;
        if (manifest.limits.maxMemoryBytes > envelopeMaxBytes) {
          errors.push(
            `Tool memory limit (${manifest.limits.maxMemoryBytes}B) exceeds envelope maxMemoryMb (${envelope.limits.maxMemoryMb}MB)`,
          );
        }
      }
      if (manifest.limits?.maxOutputBytes && envelope.limits?.maxOutputSizeBytes) {
        if (manifest.limits.maxOutputBytes > envelope.limits.maxOutputSizeBytes) {
          errors.push(
            `Tool maxOutputBytes (${manifest.limits.maxOutputBytes}B) exceeds envelope maxOutputSizeBytes (${envelope.limits.maxOutputSizeBytes}B)`,
          );
        }
      }
    }
  }

  // 6. Immutability and Compatibility checks
  if (options?.existingVersions) {
    const toolId = manifest.id;
    const existing = options.existingVersions.find(
      (v) => v.toolId === toolId && v.version === manifest.version,
    );
    if (existing) {
      if (existing.manifestDigest !== calculatedManifestDigest) {
        errors.push(
          `Version '${manifest.version}' for tool '${toolId}' is already registered with a different digest (immutability violation)`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifestDigest: calculatedManifestDigest,
    artifactDigest: calculatedArtifactDigest,
  };
}
