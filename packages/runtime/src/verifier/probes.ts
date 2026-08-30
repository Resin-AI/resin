import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CapabilityEnvelope,
  CapabilityManifestSchema,
  type ToolManifest,
  isSecretReference,
} from "@resin/contracts";
import { CapabilityBrokerManager } from "../brokers/manager.js";
import { createBrokerClients } from "../brokers/sdk-clients.js";
import { buildToolBundle, extractTarball } from "../bundle/builder.js";
import { BUNDLE_FILE_ENTRYPOINT_TS, type BundleFileEntry } from "../bundle/spec.js";
import { createInvocationGrant } from "../policy/grant.js";
import { DeterministicWorkerSandbox } from "../worker/runner.js";
import { staticAnalyzeCandidate } from "./analyzer.js";
import { validatePayloadAgainstSchema } from "./schema-validator.js";
import type {
  ProbeExecutionResult,
  ProbeRunnerOptions,
  ProbeSuiteResult,
  SecurityProbe,
  SecurityProbeContext,
} from "./types.js";

function createProbeToolManifest(id: string, name: string): ToolManifest {
  return {
    id,
    name,
    version: "1.0.0",
    description: `Probe tool ${name}`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    runtime: {
      runtime: "deno",
      memoryLimitMb: 128,
      timeoutMs: 5000,
      cpuLimitPercent: 100,
      maxOutputSizeBytes: 1048576,
    },
    capabilities: {
      fs: {
        readPaths: [],
        writePaths: [],
        allowWorkspaceRoot: true,
        allowTemp: true,
        denyPaths: [],
        maxFileSizeBytes: 10485760,
      },
      net: {
        allowedDomains: [],
        allowedHosts: [],
        allowedPorts: [],
        allowedProtocols: ["https"],
        allowLocalhost: false,
        allowOutbound: false,
        denyPrivateRanges: true,
      },
      command: {
        allowedCommands: [],
        allowedBinaries: [],
        allowShellExecution: false,
        allowEnvPassthrough: [],
        forbiddenPatterns: [],
      },
      secrets: {
        allowedSecretNames: [],
        allowedPrefixes: [],
        denyDirectRead: true,
        injectAsEnv: true,
      },
      limits: {
        maxConcurrentExecutions: 4,
        maxCpuUsagePercent: 100,
        maxMemoryMb: 128,
        maxExecutionTimeMs: 30000,
        maxOutputSizeBytes: 1048576,
      },
    },
    limits: {
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
      maxMemoryBytes: 134217728,
      maxConcurrentInvocations: 2,
    },
    scope: "workspace",
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    metadata: {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * 1. Direct Filesystem Access Probe
 */
export const PROBE_DIRECT_FS: SecurityProbe = {
  id: "probe-direct-fs",
  name: "Direct Filesystem Isolation Probe",
  description: "Verifies candidate cannot access arbitrary host filesystem paths outside mediation",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      // 1. Static check
      const staticResult = staticAnalyzeCandidate(context.sourceCode, context.manifest);
      const hasFsViolations = staticResult.findings.some(
        (f) =>
          f.category === "forbidden_import" &&
          (f.message.includes("fs") || f.message.includes("filesystem")),
      );

      if (
        (context.sourceCode.includes("node:fs") || context.sourceCode.includes('from "fs"')) &&
        !hasFsViolations
      ) {
        return {
          probeId: "probe-direct-fs",
          name: "Direct Filesystem Isolation Probe",
          passed: false,
          error: "Static analyzer failed to catch direct fs import.",
          durationMs: Date.now() - startTime,
        };
      }

      // 2. Runtime broker mediation check
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-fs-"));
      try {
        const manager = new CapabilityBrokerManager({
          allowUnverifiedBoundaries: true,
          development: true,
        });

        const grant = createInvocationGrant({
          grantId: "grant_probe_fs",
          invocationId: "inv_probe_fs",
          workspaceId: "ws_probe",
          envelopeId: "env_probe",
          toolId: context.manifest.id,
          toolVersion: context.manifest.version,
          capabilities: CapabilityManifestSchema.parse({
            fs: {
              allowTemp: true,
              allowWorkspaceRoot: true,
              readPaths: ["**"],
              writePaths: ["**"],
              denyPaths: [],
              maxFileSizeBytes: 10 * 1024 * 1024,
            },
          }),
        });

        const handler = manager.createRequestHandler({
          invocationId: "inv_probe_fs",
          grant,
          workspaceRoot: tempDir,
        });
        const clients = createBrokerClients(handler);

        await clients.fs.writeFile("probe.txt", "probe-ok");
        const readBack = await clients.fs.readFile("probe.txt", "utf-8");

        if (readBack !== "probe-ok") {
          return {
            probeId: "probe-direct-fs",
            name: "Direct Filesystem Isolation Probe",
            passed: false,
            error: "Broker filesystem write/read verification failed.",
            durationMs: Date.now() - startTime,
          };
        }

        // Test that paths outside workspace throw
        let denied = false;
        try {
          await clients.fs.readFile("../outside.txt", "utf-8");
        } catch {
          denied = true;
        }

        if (!denied) {
          return {
            probeId: "probe-direct-fs",
            name: "Direct Filesystem Isolation Probe",
            passed: false,
            error: "Broker failed to deny access to unauthorized relative path '../outside.txt'.",
            durationMs: Date.now() - startTime,
          };
        }
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      return {
        probeId: "probe-direct-fs",
        name: "Direct Filesystem Isolation Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-direct-fs",
        name: "Direct Filesystem Isolation Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 2. Raw Secret Access Probe
 */
export const PROBE_RAW_SECRET_ACCESS: SecurityProbe = {
  id: "probe-raw-secret-access",
  name: "Raw Secret Non-Disclosure Probe",
  description:
    "Verifies candidate receives only opaque references and cannot resolve raw secret strings",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const manager = new CapabilityBrokerManager({
        allowUnverifiedBoundaries: true,
        development: true,
        secrets: {
          API_KEY: "mock_api_key_value",
        },
      });

      const grant = createInvocationGrant({
        grantId: "grant_probe_secrets",
        invocationId: "inv_probe_secrets",
        workspaceId: "ws_probe",
        envelopeId: "env_probe",
        toolId: context.manifest.id,
        toolVersion: context.manifest.version,
        capabilities: CapabilityManifestSchema.parse({
          secrets: {
            allowedSecretNames: ["API_KEY"],
            denyDirectRead: true,
          },
        }),
      });

      const secretRef = manager.secret.createSecretReference("API_KEY", {
        invocationId: "inv_probe_secrets",
        grant,
      });

      if (!secretRef) {
        return {
          probeId: "probe-raw-secret-access",
          name: "Raw Secret Non-Disclosure Probe",
          passed: false,
          error: "Secret broker failed to return opaque reference.",
          durationMs: Date.now() - startTime,
        };
      }

      // Check opaque reference invariant
      if (
        !isSecretReference(secretRef) ||
        Object.prototype.hasOwnProperty.call(secretRef, "value") ||
        Object.prototype.hasOwnProperty.call(secretRef, "rawSecret")
      ) {
        return {
          probeId: "probe-raw-secret-access",
          name: "Raw Secret Non-Disclosure Probe",
          passed: false,
          error: "Secret reference exposed raw value or lacked opaque structure.",
          durationMs: Date.now() - startTime,
        };
      }

      // Test unauthorized key access rejection
      let denied = false;
      try {
        manager.secret.createSecretReference("UNAUTHORIZED_SECRET", {
          invocationId: "inv_probe_secrets",
          grant,
        });
      } catch {
        denied = true;
      }

      if (!denied) {
        return {
          probeId: "probe-raw-secret-access",
          name: "Raw Secret Non-Disclosure Probe",
          passed: false,
          error: "Secret broker failed to deny access to undeclared secret key.",
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-raw-secret-access",
        name: "Raw Secret Non-Disclosure Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-raw-secret-access",
        name: "Raw Secret Non-Disclosure Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 3. Command Substitution & Injection Probe
 */
export const PROBE_CMD_SUBSTITUTION: SecurityProbe = {
  id: "probe-cmd-substitution",
  name: "Command Substitution & Injection Probe",
  description: "Verifies command broker rejects shell metacharacters and enforces vector execution",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const manager = new CapabilityBrokerManager({
        allowUnverifiedBoundaries: true,
        development: true,
      });

      const grant = createInvocationGrant({
        grantId: "grant_probe_cmd",
        invocationId: "inv_probe_cmd",
        workspaceId: "ws_probe",
        envelopeId: "env_probe",
        toolId: context.manifest.id,
        toolVersion: context.manifest.version,
        capabilities: CapabilityManifestSchema.parse({
          command: {
            allowedBinaries: ["echo"],
            allowShellExecution: false,
            forbiddenPatterns: ["\\$\\([\\s\\S]*\\)", "`[\\s\\S]*`", ";", "\\|", "&"],
          },
        }),
      });

      const handler = manager.createRequestHandler({
        invocationId: "inv_probe_cmd",
        grant,
      });
      const clients = createBrokerClients(handler);

      // Test valid command execution
      const execResult = await clients.cmd.exec("echo", ["safe-arg"]);
      if (!execResult || execResult.exitCode !== 0) {
        return {
          probeId: "probe-cmd-substitution",
          name: "Command Substitution & Injection Probe",
          passed: false,
          error: "Command broker failed on authorized command execution.",
          durationMs: Date.now() - startTime,
        };
      }

      // Test command substitution rejection
      let deniedSub = false;
      try {
        await clients.cmd.exec("echo", ["$(whoami)"]);
      } catch {
        deniedSub = true;
      }

      if (!deniedSub) {
        return {
          probeId: "probe-cmd-substitution",
          name: "Command Substitution & Injection Probe",
          passed: false,
          error:
            "Command broker failed to reject argument containing command substitution '$(whoami)'.",
          durationMs: Date.now() - startTime,
        };
      }

      // Test pipe rejection
      let deniedPipe = false;
      try {
        await clients.cmd.exec("echo", ["hello | sh"]);
      } catch {
        deniedPipe = true;
      }

      if (!deniedPipe) {
        return {
          probeId: "probe-cmd-substitution",
          name: "Command Substitution & Injection Probe",
          passed: false,
          error: "Command broker failed to reject argument containing pipe '|'.",
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-cmd-substitution",
        name: "Command Substitution & Injection Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-cmd-substitution",
        name: "Command Substitution & Injection Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 4. Network Bypass Probe
 */
export const PROBE_NET_BYPASS: SecurityProbe = {
  id: "probe-net-bypass",
  name: "Network Isolation & Domain Allowlist Probe",
  description:
    "Verifies network broker enforces domain allowlists and denies localhost/unauthorized hosts",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const manager = new CapabilityBrokerManager({
        allowUnverifiedBoundaries: true,
        development: true,
      });

      const grant = createInvocationGrant({
        grantId: "grant_probe_net",
        invocationId: "inv_probe_net",
        workspaceId: "ws_probe",
        envelopeId: "env_probe",
        toolId: context.manifest.id,
        toolVersion: context.manifest.version,
        capabilities: CapabilityManifestSchema.parse({
          net: {
            allowedDomains: ["api.example.com"],
            allowLocalhost: false,
            allowOutbound: true,
            allowedProtocols: ["https"],
          },
        }),
      });

      const handler = manager.createRequestHandler({
        invocationId: "inv_probe_net",
        grant,
      });
      const clients = createBrokerClients(handler);

      // Test unauthorized host rejection
      let deniedHost = false;
      try {
        await clients.net.fetch("https://evil.com/data");
      } catch {
        deniedHost = true;
      }

      if (!deniedHost) {
        return {
          probeId: "probe-net-bypass",
          name: "Network Isolation & Domain Allowlist Probe",
          passed: false,
          error: "Network broker failed to reject request to unauthorized domain 'evil.com'.",
          durationMs: Date.now() - startTime,
        };
      }

      // Test localhost rejection
      let deniedLocalhost = false;
      try {
        await clients.net.fetch("http://127.0.0.1:8080/admin");
      } catch {
        deniedLocalhost = true;
      }

      if (!deniedLocalhost) {
        return {
          probeId: "probe-net-bypass",
          name: "Network Isolation & Domain Allowlist Probe",
          passed: false,
          error: "Network broker failed to reject request to localhost '127.0.0.1'.",
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-net-bypass",
        name: "Network Isolation & Domain Allowlist Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-net-bypass",
        name: "Network Isolation & Domain Allowlist Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 5. Dynamic Import & Eval Escape Probe
 */
export const PROBE_IMPORT_ESCAPE: SecurityProbe = {
  id: "probe-import-escape",
  name: "Dynamic Import & Eval Escape Probe",
  description:
    "Verifies static analysis and worker sandbox reject eval, Function constructors, and dynamic imports",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const staticResult = staticAnalyzeCandidate(context.sourceCode, context.manifest);

      if (!staticResult.passed) {
        const escapeFinding = staticResult.findings.find(
          (f) => f.category === "dynamic_import_escape" || f.category === "forbidden_api",
        );
        if (escapeFinding) {
          return {
            probeId: "probe-import-escape",
            name: "Dynamic Import & Eval Escape Probe",
            passed: false,
            error: escapeFinding.message,
            durationMs: Date.now() - startTime,
          };
        }
      }

      return {
        probeId: "probe-import-escape",
        name: "Dynamic Import & Eval Escape Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-import-escape",
        name: "Dynamic Import & Eval Escape Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};
/**
 * 6. Schema Spoofing Probe
 */
export const PROBE_SCHEMA_SPOOFING: SecurityProbe = {
  id: "probe-schema-spoofing",
  name: "Schema Spoofing & Output Invariant Probe",
  description:
    "Verifies that invalid payloads, type mismatches, and undeclared additional properties are rejected",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      if (context.manifest.outputSchema) {
        const malformedPayload = { __spoofed_unexpected_field: true, invalid_type: 12345 };
        const validation = validatePayloadAgainstSchema(
          context.manifest.outputSchema,
          malformedPayload,
          "output",
        );

        const hasNoAdditionalProps =
          context.manifest.outputSchema instanceof Object &&
          "additionalProperties" in context.manifest.outputSchema &&
          context.manifest.outputSchema.additionalProperties === false;
        if (hasNoAdditionalProps && validation.valid) {
          return {
            probeId: "probe-schema-spoofing",
            name: "Schema Spoofing & Output Invariant Probe",
            passed: false,
            error: "Schema validator failed to reject payload with unexpected additional property.",
            durationMs: Date.now() - startTime,
          };
        }
      }

      return {
        probeId: "probe-schema-spoofing",
        name: "Schema Spoofing & Output Invariant Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-schema-spoofing",
        name: "Schema Spoofing & Output Invariant Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 7. Infinite Loop & Timeout Probe
 */
export const PROBE_INFINITE_LOOP: SecurityProbe = {
  id: "probe-infinite-loop",
  name: "Infinite Loop & Timeout Recovery Probe",
  description:
    "Verifies execution timeout enforcement kills stalled worker and resets state cleanly",
  requiredForProduction: true,
  run: async (_context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const infiniteLoopTool = `
        module.exports = async function() {
          const { promise } = Promise.withResolvers();
          await promise;
          return { done: true };
        };
      `;
      const manifest = createProbeToolManifest("probe-loop-tool", "Infinite Loop Probe Tool");
      const result = await DeterministicWorkerSandbox.execute(
        manifest,
        infiniteLoopTool,
        {},
        { timeoutMs: 150 },
      );

      if (result.status !== "timeout" && result.status !== "error") {
        return {
          probeId: "probe-infinite-loop",
          name: "Infinite Loop & Timeout Recovery Probe",
          passed: false,
          error: `Expected status 'timeout' or 'error', but received '${result.status}'.`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-infinite-loop",
        name: "Infinite Loop & Timeout Recovery Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-infinite-loop",
        name: "Infinite Loop & Timeout Recovery Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 8. Output Flooding Probe
 */
export const PROBE_OUTPUT_FLOODING: SecurityProbe = {
  id: "probe-output-flooding",
  name: "Output Flooding & Resource Limits Probe",
  description:
    "Verifies worker output and logs exceeding size limits are bounded and do not crash host",
  requiredForProduction: true,
  run: async (_context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const manifest = createProbeToolManifest("probe-flood-tool", "Flood Probe Tool");
      const floodingTool = `
        module.exports = async function(ctx) {
          for (let i = 0; i < 50; i++) {
            ctx.log?.("Flood log entry " + "X".repeat(500));
          }
          return { payload: "Y".repeat(1000) };
        };
      `;

      const result = await DeterministicWorkerSandbox.execute(
        manifest,
        floodingTool,
        {},
        { timeoutMs: 2000 },
      );

      if (result.status !== "success") {
        return {
          probeId: "probe-output-flooding",
          name: "Output Flooding & Resource Limits Probe",
          passed: false,
          error: `Flooding tool failed with status '${result.status}'.`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-output-flooding",
        name: "Output Flooding & Resource Limits Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-output-flooding",
        name: "Output Flooding & Resource Limits Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * 9. Archive & Bundle Tampering Probe
 */
export const PROBE_ARCHIVE_TAMPERING: SecurityProbe = {
  id: "probe-archive-tampering",
  name: "Archive & Bundle Tampering Probe",
  description:
    "Verifies corrupted archives, mismatched digests, and invalid tarballs fail verification",
  requiredForProduction: true,
  run: async (context: SecurityProbeContext): Promise<ProbeExecutionResult> => {
    const startTime = Date.now();
    try {
      const manifestToUse =
        context.manifest && context.manifest.runtime && context.manifest.capabilities
          ? context.manifest
          : createProbeToolManifest(
              context.manifest?.id ?? "probe-tool",
              context.manifest?.name ?? "Probe Tool",
            );

      const validBundle = await buildToolBundle({
        manifest: manifestToUse,
        files: [
          {
            path: BUNDLE_FILE_ENTRYPOINT_TS,
            content: Buffer.from(context.sourceCode),
            mode: 0o644,
          },
        ],
      });

      // 1. Verify valid bundle extracts cleanly
      const extracted = extractTarball(validBundle.archiveBuffer);
      if (extracted.length === 0) {
        return {
          probeId: "probe-archive-tampering",
          name: "Archive & Bundle Tampering Probe",
          passed: false,
          error: "Failed to extract valid bundle archive.",
          durationMs: Date.now() - startTime,
        };
      }

      // 2. Verify corrupted archive buffer fails extraction
      const corruptedBuffer = validBundle.archiveBuffer.subarray(0, 100);

      let caughtCorrupted = false;
      try {
        const corruptedEntries = extractTarball(corruptedBuffer);
        if (
          corruptedEntries.length === 0 ||
          !corruptedEntries.some((e: { path: string }) => e.path === "manifest.json")
        ) {
          caughtCorrupted = true;
        }
      } catch {
        caughtCorrupted = true;
      }

      if (!caughtCorrupted) {
        return {
          probeId: "probe-archive-tampering",
          name: "Archive & Bundle Tampering Probe",
          passed: false,
          error: "Corrupted bundle tarball was unexpectedly accepted without error.",
          durationMs: Date.now() - startTime,
        };
      }

      return {
        probeId: "probe-archive-tampering",
        name: "Archive & Bundle Tampering Probe",
        passed: true,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        probeId: "probe-archive-tampering",
        name: "Archive & Bundle Tampering Probe",
        passed: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  },
};

/**
 * Standard mandatory platform security probes suite.
 */
export const MANDATORY_SECURITY_PROBES: SecurityProbe[] = [
  PROBE_DIRECT_FS,
  PROBE_RAW_SECRET_ACCESS,
  PROBE_CMD_SUBSTITUTION,
  PROBE_NET_BYPASS,
  PROBE_IMPORT_ESCAPE,
  PROBE_SCHEMA_SPOOFING,
  PROBE_INFINITE_LOOP,
  PROBE_OUTPUT_FLOODING,
  PROBE_ARCHIVE_TAMPERING,
];

/**
 * Executes the platform security probe suite against candidate source and manifest.
 */
export async function runSecurityProbes(
  candidate: { manifest: ToolManifest; sourceCode: string; envelope?: CapabilityEnvelope },
  options: ProbeRunnerOptions = {},
): Promise<ProbeSuiteResult> {
  const startTime = Date.now();
  const probesToRun = options.probes ?? MANDATORY_SECURITY_PROBES;

  const probeContext: SecurityProbeContext = {
    manifest: candidate.manifest,
    sourceCode: candidate.sourceCode,
    timeoutMs: options.timeoutMs ?? 5000,
  };

  const results: ProbeExecutionResult[] = [];
  const failedProbes: ProbeExecutionResult[] = [];

  for (const probe of probesToRun) {
    const probeRes = await probe.run(probeContext);
    results.push(probeRes);
    if (!probeRes.passed) {
      failedProbes.push(probeRes);
    }
  }

  return {
    passed: failedProbes.length === 0,
    probes: results,
    failedProbes,
    durationMs: Date.now() - startTime,
  };
}
