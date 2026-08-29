import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  type ToolManifest,
  ToolManifestSchema,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import { CapabilityBrokerManager } from "../brokers/manager.js";
import type { SecretBroker } from "../brokers/secret-broker.js";
import { computeSha256 } from "../bundle/builder.js";
import type { LoadedToolBundle } from "../loader/loader.js";
import type {
  ApprovedEffectBoundaries,
  ExternalActionAuthorizationRecord,
  ExternalActionAuthorizationVerifier,
  VerifiedQualificationToken,
} from "../monitor/index.js";
import { getVerifiedQualificationData, isVerifiedQualificationToken } from "../monitor/token.js";
import type { InvocationGrant } from "../policy/grant.js";
import { validateAgainstSchema } from "./bootstrap.js";
import { WorkerProcess } from "./process.js";
import {
  type ErrorMessage,
  type LogMessage,
  type ProgressMessage,
  createLogMessage,
  createProgressMessage,
  withResolvers,
} from "./protocol.js";
import {
  type BrokerRequestHandlerFn,
  type ToolContext,
  createToolContext,
  defineTool,
} from "./sdk.js";

/**
 * Tool execution modes.
 */
export type ExecutionMode = "auto" | "deno" | "in-process" | "sandbox-vm";

/**
 * Options for executing a tool via ToolRuntime.
 */
export interface ToolExecutionOptions {
  timeoutMs?: number;
  memoryLimitMb?: number;
  maxOutputSizeBytes?: number;
  mode?: ExecutionMode;
  denoExecutable?: string;
  brokerHandler?: BrokerRequestHandlerFn;
  onProgress?: (progress: ProgressMessage) => void;
  onLog?: (log: LogMessage) => void;
  environment?: Record<string, string>;
  workspaceRoot?: string;
  sessionId?: string;
  workspaceId?: string;
  allowDirectHostAccess?: boolean;
  allowUnsafeVmFallback?: boolean;
  grant?: InvocationGrant;
  brokerManager?: CapabilityBrokerManager;
  secretBroker?: SecretBroker;
  secrets?: Record<string, string>;
  token?: VerifiedQualificationToken;
  qualificationToken?: VerifiedQualificationToken;
  loadedBundle?: LoadedToolBundle;
  externalAuthorizations?:
    | readonly ExternalActionAuthorizationRecord[]
    | ExternalActionAuthorizationRecord[];
  authorizationVerifier?: ExternalActionAuthorizationVerifier;
  defaultBoundaries?: VerifiedQualificationToken | ApprovedEffectBoundaries;
  allowUnverifiedBoundaries?: boolean;
  development?: boolean;
  strict?: boolean;
}

/**
 * Structured invocation result returned by ToolRuntime.
 */
export interface InvocationResult {
  status: "success" | "error" | "timeout" | "cancelled" | "validation_error";
  output?: unknown;
  error?: {
    type: string;
    message: string;
    stack?: string;
    details?: unknown;
  };
  durationMs: number;
  resourceUsage?: {
    cpuTimeMs?: number;
    memoryBytes?: number;
  };
  logs: LogMessage[];
  progress: ProgressMessage[];
}

/**
 * Helper to check whether Deno is installed and accessible in the current environment.
 */
function isDenoAvailable(denoExecutable?: string): boolean {
  const exe = denoExecutable ?? "deno";
  try {
    const res = spawnSync(exe, ["--version"], {
      stdio: "ignore",
      encoding: "utf-8",
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * In-process deterministic VM execution environment for running tools in isolated contexts.
 */
export class DeterministicWorkerSandbox {
  /**
   * Executes a tool handler or bundle entrypoint in an isolated, permissionless context.
   */
  static async execute(
    manifest: ToolManifest | Record<string, unknown>,
    bundleOrHandler: string | ((ctx: ToolContext) => unknown | Promise<unknown>),
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<InvocationResult> {
    const startTime = Date.now();
    const invocationId =
      options.grant?.invocationId ??
      options.sessionId ??
      `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const manifestLimits =
      manifest &&
      typeof manifest === "object" &&
      "limits" in manifest &&
      manifest.limits &&
      typeof manifest.limits === "object"
        ? (manifest.limits as Record<string, unknown>)
        : {};
    const timeoutMs =
      options.timeoutMs ??
      (typeof manifestLimits.timeoutMs === "number" ? manifestLimits.timeoutMs : 30000);
    const logs: LogMessage[] = [];
    const progressList: ProgressMessage[] = [];

    // Create unique scratch directory
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-sandbox-"));

    const onLog = (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => {
      const msg = createLogMessage({ invocationId, level, message, data });
      logs.push(msg);
      options.onLog?.(msg);
    };

    const onProgress = (percentage: number, message?: string, stage?: string) => {
      const msg = createProgressMessage({ invocationId, percentage, message, stage });
      progressList.push(msg);
      options.onProgress?.(msg);
    };

    let manager = options.brokerManager;
    let rawOutput: unknown;

    try {
      // 1. Validate input against manifest parameters schema
      if (manifest.parameters) {
        const inputValidation = validateAgainstSchema(manifest.parameters, input, "input");
        if (!inputValidation.valid) {
          return {
            status: "validation_error",
            error: {
              type: "validation_error",
              message: `Input validation failed: ${inputValidation.errors.join("; ")}`,
              details: { errors: inputValidation.errors },
            },
            durationMs: Date.now() - startTime,
            logs,
            progress: progressList,
          };
        }
      }

      // 2. Set up context & capability brokers
      let effectiveBrokerHandler = options.brokerHandler;
      let toolName = "unknown";
      let toolVersion: string | undefined;
      if (typeof manifest === "object" && manifest !== null) {
        if ("id" in manifest && manifest.id) {
          toolName = String(manifest.id);
        } else if ("name" in manifest && manifest.name) {
          toolName = String(manifest.name);
        }
        if ("version" in manifest && manifest.version) {
          toolVersion = String(manifest.version);
        }
      }

      if (
        !manager &&
        (options.grant ||
          options.secretBroker ||
          options.secrets ||
          options.token ||
          options.qualificationToken ||
          options.defaultBoundaries)
      ) {
        manager = new CapabilityBrokerManager({
          requireGrant: Boolean(options.grant),
          secretBroker: options.secretBroker,
          secrets: options.secrets,
          defaultBoundaries:
            options.defaultBoundaries ?? options.token ?? options.qualificationToken,
          allowUnverifiedBoundaries: options.allowUnverifiedBoundaries,
          development: options.development,
          authorizationVerifier: options.authorizationVerifier,
          strict: options.strict ?? !(options.development || options.allowUnverifiedBoundaries),
        });
      }

      if (manager) {
        const qualToken =
          options.token ??
          options.qualificationToken ??
          options.loadedBundle?.qualificationToken ??
          (isVerifiedQualificationToken(manifest)
            ? manifest
            : ((manifest as Record<string, unknown>)?.qualificationToken ??
              (manifest as Record<string, unknown>)?.token));

        if (
          !manager.effectMonitor.getSession(invocationId) &&
          (qualToken ||
            options.externalAuthorizations ||
            options.authorizationVerifier ||
            options.defaultBoundaries)
        ) {
          manager.registerInvocation({
            invocationId,
            toolId: toolName,
            toolVersion,
            token: (isVerifiedQualificationToken(qualToken) ? qualToken : undefined) as
              | VerifiedQualificationToken
              | undefined,
            boundaries: (isVerifiedQualificationToken(qualToken)
              ? qualToken
              : options.defaultBoundaries) as VerifiedQualificationToken | undefined,
            externalAuthorizations: options.externalAuthorizations,
            authorizationVerifier: options.authorizationVerifier,
            workspaceRoot: options.workspaceRoot,
            scratchDir,
          });
        }

        if (!effectiveBrokerHandler) {
          effectiveBrokerHandler = manager.createRequestHandler({
            invocationId,
            grant: options.grant,
            workspaceRoot: options.workspaceRoot ?? process.cwd(),
            scratchDir,
            sessionId: options.sessionId,
            workspaceId: options.workspaceId,
            toolId: toolName,
            toolVersion: toolVersion,
          });
        }
      }

      const defaultBrokerHandler: BrokerRequestHandlerFn =
        effectiveBrokerHandler ??
        (async () => {
          throw new Error("No broker handler configured for sandbox");
        });
      const toolContext = createToolContext({
        input,
        invocationId,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        scratchDir,
        metadata: {
          sessionId: options.sessionId,
          workspaceId: options.workspaceId,
        },
        onLog,
        onProgress,
        brokerHandler: defaultBrokerHandler,
      });

      // 3. Resolve tool handler
      let handler: (ctx: ToolContext) => unknown | Promise<unknown>;

      if (typeof bundleOrHandler === "function") {
        handler = bundleOrHandler;
      } else {
        const bundlePath = bundleOrHandler;
        let fileContent: string;
        if (fs.existsSync(bundlePath)) {
          const stat = fs.statSync(bundlePath);
          if (stat.isDirectory()) {
            const entryTs = path.join(bundlePath, "src/index.ts");
            const entryJs = path.join(bundlePath, "src/index.js");
            const entryDirect = path.join(bundlePath, "index.js");
            const target = fs.existsSync(entryTs)
              ? entryTs
              : fs.existsSync(entryJs)
                ? entryJs
                : fs.existsSync(entryDirect)
                  ? entryDirect
                  : null;
            if (!target) {
              throw new Error(`Cannot find entrypoint in bundle directory: ${bundlePath}`);
            }
            fileContent = fs.readFileSync(target, "utf-8");
          } else {
            fileContent = fs.readFileSync(bundlePath, "utf-8");
          }
        } else {
          fileContent = bundlePath; // treated as inline code
        }

        // Execute inside permissionless VM sandbox context
        handler = DeterministicWorkerSandbox.compileSandboxedHandler(fileContent, options);
      }

      // 4. Run handler with timeout
      const {
        promise: execPromise,
        resolve: execResolve,
        reject: execReject,
      } = withResolvers<unknown>();

      const timer = setTimeout(() => {
        execReject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const handlerResult = handler(toolContext);
        if (handlerResult && typeof (handlerResult as Promise<unknown>).then === "function") {
          (handlerResult as Promise<unknown>)
            .then((res) => execResolve(res))
            .catch((err) => execReject(err));
        } else {
          execResolve(handlerResult);
        }
        rawOutput = await execPromise;
      } finally {
        clearTimeout(timer);
      }
    } catch (runErr) {
      const isTimeout =
        runErr instanceof Error && runErr.message.toLowerCase().includes("timed out");
      return {
        status: isTimeout ? "timeout" : "error",
        error: {
          type: isTimeout ? "timeout" : "execution_error",
          message: runErr instanceof Error ? runErr.message : String(runErr),
          stack: runErr instanceof Error ? runErr.stack : undefined,
        },
        durationMs: Date.now() - startTime,
        logs,
        progress: progressList,
      };
    } finally {
      // Scratch directory cleanup
      try {
        if (fs.existsSync(scratchDir)) {
          fs.rmSync(scratchDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }
    }

    // 5. Validate output against outputSchema
    if (manifest.outputSchema) {
      const outputValidation = validateAgainstSchema(manifest.outputSchema, rawOutput, "output");
      if (!outputValidation.valid) {
        return {
          status: "validation_error",
          error: {
            type: "validation_error",
            message: `Output validation failed: ${outputValidation.errors.join("; ")}`,
            details: { errors: outputValidation.errors },
          },
          durationMs: Date.now() - startTime,
          logs,
          progress: progressList,
        };
      }
    }

    if (manager) {
      const valRes = manager.finalizeInvocation(invocationId, {
        cpuTimeMs: Date.now() - startTime,
        wallDurationMs: Date.now() - startTime,
      });
      manager.cleanupInvocation(invocationId);
      if (!valRes.success) {
        return {
          status: "error",
          error: {
            type: "boundary_violation",
            message:
              valRes.violations?.join("; ") ?? "Invocation failed qualification boundary checks",
            details: { violations: valRes.violations, quarantineRecord: valRes.quarantineRecord },
          },
          durationMs: Date.now() - startTime,
          logs,
          progress: progressList,
        };
      }
    }

    return {
      status: "success",
      output: rawOutput,
      durationMs: Date.now() - startTime,
      resourceUsage: {
        cpuTimeMs: Date.now() - startTime,
        memoryBytes: process.memoryUsage().heapUsed,
      },
      logs,
      progress: progressList,
    };
  }

  /**
   * Compiles code inside a Node VM context with ambient access denied.
   */
  private static compileSandboxedHandler(
    code: string,
    options: ToolExecutionOptions,
  ): (ctx: ToolContext) => unknown | Promise<unknown> {
    const sandboxExports: Record<string, unknown> = {};
    const sandboxModule = { exports: sandboxExports };

    // Transform ES Module export default / export const to CommonJS for Node VM script execution
    let transformedCode = code;
    if (transformedCode.includes("export default")) {
      transformedCode = transformedCode.replace(/export\s+default\s+/, "module.exports = ");
    }
    if (transformedCode.includes("export const")) {
      transformedCode = transformedCode.replace(
        /export\s+const\s+([a-zA-Z0-9_$]+)\s*=/g,
        "exports.$1 =",
      );
    }

    // Strict permissionless sandbox environment
    const sandboxGlobals: Record<string, unknown> = {
      module: sandboxModule,
      exports: sandboxExports,
      console: {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      require: (modName: string) => {
        throw new Error(
          `Permission Denied: direct require('${modName}') is not allowed in sandbox`,
        );
      },
      fetch: () => {
        throw new Error(
          "Permission Denied: direct fetch() is not allowed in permissionless sandbox",
        );
      },
      process: {
        env: {},
        exit: () => {
          throw new Error("Permission Denied: process.exit is not allowed in sandbox");
        },
      },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      Buffer: {
        from: Buffer.from,
        alloc: Buffer.alloc,
        isBuffer: Buffer.isBuffer,
      },
      URL,
      URLSearchParams,
      defineTool,
    };

    const context = vm.createContext(sandboxGlobals, {
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    });

    const script = new vm.Script(transformedCode, {
      filename: "bundle-entrypoint.js",
    });

    script.runInContext(context, {
      timeout: options.timeoutMs ?? 30000,
    });

    const candidate = sandboxModule.exports;
    let handler: unknown;

    if (typeof candidate === "function") {
      handler = candidate;
    } else if (candidate && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      if (typeof record.default === "function") {
        handler = record.default;
      } else if (typeof record.handler === "function") {
        handler = record.handler;
      } else if (typeof record.run === "function") {
        handler = record.run;
      } else if (typeof record.execute === "function") {
        handler = record.execute;
      }
    }

    if (typeof handler !== "function") {
      throw new Error(
        "Tool bundle must export a function (default, handler, run, or execute) accepting ToolContext",
      );
    }

    return handler as (ctx: ToolContext) => unknown | Promise<unknown>;
  }
}

/**
 * ToolRuntime: Primary interface for executing generated tools in isolated sandboxes.
 */
export class ToolRuntime {
  private readonly brokerManager?: CapabilityBrokerManager;
  constructor(
    private readonly defaultOptions: ToolExecutionOptions = {},
    brokerManager?: CapabilityBrokerManager,
  ) {
    if (brokerManager) {
      this.brokerManager = brokerManager;
    } else if (defaultOptions.brokerManager) {
      this.brokerManager = defaultOptions.brokerManager;
    } else if (
      defaultOptions.secretBroker ||
      defaultOptions.secrets ||
      defaultOptions.token ||
      defaultOptions.qualificationToken ||
      defaultOptions.defaultBoundaries ||
      defaultOptions.authorizationVerifier
    ) {
      this.brokerManager = new CapabilityBrokerManager({
        requireGrant: Boolean(defaultOptions.grant),
        secretBroker: defaultOptions.secretBroker,
        secrets: defaultOptions.secrets,
        defaultBoundaries:
          defaultOptions.defaultBoundaries ??
          defaultOptions.token ??
          defaultOptions.qualificationToken,
        allowUnverifiedBoundaries: defaultOptions.allowUnverifiedBoundaries,
        development: defaultOptions.development,
        authorizationVerifier: defaultOptions.authorizationVerifier,
        strict:
          defaultOptions.strict ??
          !(defaultOptions.development || defaultOptions.allowUnverifiedBoundaries),
      });
    }
  }

  /**
   * Executes a tool defined by manifest and bundle/handler in an isolated sandbox.
   */
  async executeTool(
    manifest: ToolManifest | Record<string, unknown>,
    bundlePathOrHandler: string | ((ctx: ToolContext) => unknown | Promise<unknown>),
    input: unknown,
    options: ToolExecutionOptions = {},
  ): Promise<InvocationResult> {
    let brokerManager =
      options.brokerManager ?? this.brokerManager ?? this.defaultOptions.brokerManager;
    if (!brokerManager) {
      brokerManager = new CapabilityBrokerManager({
        requireGrant: Boolean(options.grant ?? this.defaultOptions.grant),
        secretBroker: options.secretBroker ?? this.defaultOptions.secretBroker,
        secrets: options.secrets ?? this.defaultOptions.secrets,
        defaultBoundaries:
          options.defaultBoundaries ??
          this.defaultOptions.defaultBoundaries ??
          options.token ??
          options.qualificationToken ??
          this.defaultOptions.token ??
          this.defaultOptions.qualificationToken,
        allowUnverifiedBoundaries:
          options.allowUnverifiedBoundaries ?? this.defaultOptions.allowUnverifiedBoundaries,
        development: options.development ?? this.defaultOptions.development,
        authorizationVerifier:
          options.authorizationVerifier ?? this.defaultOptions.authorizationVerifier,
        strict:
          options.strict ??
          this.defaultOptions.strict ??
          !(
            options.development ||
            options.allowUnverifiedBoundaries ||
            this.defaultOptions.development ||
            this.defaultOptions.allowUnverifiedBoundaries
          ),
      });
    }

    const mergedOptions: ToolExecutionOptions = {
      ...this.defaultOptions,
      brokerManager,
      ...options,
    };

    const invocationId =
      mergedOptions.grant?.invocationId ??
      mergedOptions.sessionId ??
      `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    let toolName = "unknown";
    let toolVersion: string | undefined;
    if (typeof manifest === "object" && manifest !== null) {
      if ("id" in manifest && manifest.id) {
        toolName = String(manifest.id);
      } else if ("name" in manifest && manifest.name) {
        toolName = String(manifest.name);
      }
      if ("version" in manifest && manifest.version) {
        toolVersion = String(manifest.version);
      }
    }

    // Extract verified qualification token from options or manifest or loaded bundle
    const qualToken =
      mergedOptions.token ??
      mergedOptions.qualificationToken ??
      mergedOptions.loadedBundle?.qualificationToken ??
      (isVerifiedQualificationToken(manifest)
        ? manifest
        : ((manifest as Record<string, unknown>)?.qualificationToken ??
          (manifest as Record<string, unknown>)?.token));

    let actualSourceDigest: string | undefined;
    let actualDependencies: Record<string, string> | undefined;

    // Verify token identity, source, schema, and dependencies against manifest and entrypoint
    if (qualToken && isVerifiedQualificationToken(qualToken)) {
      const verifiedData = getVerifiedQualificationData(qualToken);
      if (verifiedData) {
        if (toolName !== "unknown" && verifiedData.toolId && toolName !== verifiedData.toolId) {
          throw new Error(
            `Tool identity mismatch: manifest toolId '${toolName}' does not match verified qualification token toolId '${verifiedData.toolId}'`,
          );
        }
        if (
          toolVersion !== undefined &&
          verifiedData.toolVersion &&
          toolVersion !== verifiedData.toolVersion
        ) {
          throw new Error(
            `Tool version mismatch: manifest toolVersion '${toolVersion}' does not match verified qualification token toolVersion '${verifiedData.toolVersion}'`,
          );
        }

        // Verify input schema digest if parameters are present
        if (manifest.parameters && verifiedData.schemaDigest) {
          const computedSchemaDigest = normalizeSha256(
            computeSha256(canonicalJson(manifest.parameters)),
            false,
          );
          const expectedSchemaDigest = normalizeSha256(verifiedData.schemaDigest, false);
          if (computedSchemaDigest !== expectedSchemaDigest) {
            throw new Error(
              `Input schema digest mismatch: manifest parameters digest '${computedSchemaDigest}' does not match verified qualification token schemaDigest '${expectedSchemaDigest}'`,
            );
          }
        }

        // Verify source code digest against verified qualification token
        if (typeof bundlePathOrHandler === "string") {
          let sourceContent: string | null = null;
          let bundleDir: string | null = null;

          if (fs.existsSync(bundlePathOrHandler)) {
            const stat = fs.statSync(bundlePathOrHandler);
            if (stat.isDirectory()) {
              bundleDir = bundlePathOrHandler;
              const entryTs = path.join(bundlePathOrHandler, "src/index.ts");
              const entryJs = path.join(bundlePathOrHandler, "src/index.js");
              const entryDirect = path.join(bundlePathOrHandler, "index.js");
              const target = fs.existsSync(entryTs)
                ? entryTs
                : fs.existsSync(entryJs)
                  ? entryJs
                  : fs.existsSync(entryDirect)
                    ? entryDirect
                    : null;
              if (target) {
                sourceContent = fs.readFileSync(target, "utf-8");
              } else {
                throw new Error(
                  `Cannot find entrypoint in bundle directory: ${bundlePathOrHandler}`,
                );
              }
            } else {
              bundleDir = path.dirname(bundlePathOrHandler);
              sourceContent = fs.readFileSync(bundlePathOrHandler, "utf-8");
            }
          } else {
            sourceContent = bundlePathOrHandler; // treated as inline code
          }

          if (sourceContent !== null) {
            const computedSourceDigest = normalizeSha256(computeSha256(sourceContent), false);
            actualSourceDigest = computedSourceDigest;
            const expectedSourceDigest = normalizeSha256(verifiedData.sourceDigest, false);
            if (computedSourceDigest !== expectedSourceDigest) {
              throw new Error(
                `Source code digest mismatch: entrypoint source digest '${computedSourceDigest}' does not match verified qualification token sourceDigest '${expectedSourceDigest}'`,
              );
            }
          }

          // Verify package.json and package-lock.json dependencies if present
          if (bundleDir) {
            const pkgPath = path.join(bundleDir, "package.json");
            const lockPath = path.join(bundleDir, "package-lock.json");

            if (fs.existsSync(pkgPath)) {
              const pkgContent = fs.readFileSync(pkgPath, "utf-8");
              let pkgParsed: Record<string, unknown> = {};
              try {
                pkgParsed = JSON.parse(pkgContent);
              } catch (err) {
                throw new Error(
                  `Invalid package.json in bundle directory: ${err instanceof Error ? err.message : String(err)}`,
                );
              }

              const rawDeps =
                typeof pkgParsed.dependencies === "object" &&
                pkgParsed.dependencies !== null &&
                !Array.isArray(pkgParsed.dependencies)
                  ? (pkgParsed.dependencies as Record<string, unknown>)
                  : {};
              const deps: Record<string, string> = {};
              for (const [k, v] of Object.entries(rawDeps)) {
                if (typeof v === "string") deps[k] = v;
              }
              actualDependencies = deps;

              const expectedDep = normalizeSha256(verifiedData.depDigest, false);

              if (fs.existsSync(lockPath)) {
                const lockContent = fs.readFileSync(lockPath, "utf-8");
                let lockParsed: Record<string, unknown> = {};
                try {
                  lockParsed = JSON.parse(lockContent);
                } catch (err) {
                  throw new Error(
                    `Invalid package-lock.json in bundle directory: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                const lockGraph = { package: pkgParsed, lock: lockParsed };
                const canonicalLockGraphDigest = normalizeSha256(
                  computeSha256(canonicalJson(lockGraph)),
                  false,
                );

                if (canonicalLockGraphDigest !== expectedDep) {
                  throw new Error(
                    `Dependency and package-lock graph digest mismatch: computed lock graph digest '${canonicalLockGraphDigest}' does not match verified qualification token dependencyDigest '${expectedDep}'`,
                  );
                }
              } else {
                throw new Error(
                  `Tool bundle with package.json is missing required package-lock.json lock graph (expected dependencyDigest: ${expectedDep})`,
                );
              }
            } else if (verifiedData.depDigest) {
              const expectedDep = normalizeSha256(verifiedData.depDigest, false);
              const emptyLockGraph = { package: {}, lock: {} };
              const canonicalEmptyLockGraphDigest = normalizeSha256(
                computeSha256(canonicalJson(emptyLockGraph)),
                false,
              );

              if (expectedDep !== canonicalEmptyLockGraphDigest) {
                throw new Error(
                  `Tool bundle is missing required package.json for dependency verification (expected dependencyDigest: ${expectedDep})`,
                );
              }
            }
          }
        }
      }
    }

    // Register invocation boundary before any broker dispatch
    if (
      (qualToken && isVerifiedQualificationToken(qualToken)) ||
      mergedOptions.defaultBoundaries ||
      mergedOptions.development ||
      mergedOptions.allowUnverifiedBoundaries
    ) {
      brokerManager.registerInvocation({
        invocationId,
        toolId: toolName,
        toolVersion,
        token: (isVerifiedQualificationToken(qualToken) ? qualToken : undefined) as
          | VerifiedQualificationToken
          | undefined,
        boundaries: (isVerifiedQualificationToken(qualToken)
          ? qualToken
          : mergedOptions.defaultBoundaries) as VerifiedQualificationToken | undefined,
        externalAuthorizations: mergedOptions.externalAuthorizations,
        authorizationVerifier: mergedOptions.authorizationVerifier,
        workspaceRoot: mergedOptions.workspaceRoot,
        actualSourceDigest,
        actualDependencies,
      });
    }

    const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
    const mode = mergedOptions.mode ?? (isTestRuntime ? "sandbox-vm" : "deno");

    if (typeof bundlePathOrHandler === "function") {
      if (mode !== "in-process" && mode !== "sandbox-vm") {
        throw new Error(
          "Direct function handlers are test-only and cannot execute in Deno production mode",
        );
      }
      if (!isTestRuntime && !mergedOptions.allowUnsafeVmFallback) {
        throw new Error(
          "In-process generated-tool execution is disabled outside explicit test mode",
        );
      }
      return await DeterministicWorkerSandbox.execute(manifest, bundlePathOrHandler, input, {
        ...mergedOptions,
        sessionId: invocationId,
      });
    }

    if (mode === "in-process" || mode === "sandbox-vm") {
      if (!isTestRuntime && !mergedOptions.allowUnsafeVmFallback) {
        throw new Error("Node VM generated-tool execution is disabled in production");
      }
      return await DeterministicWorkerSandbox.execute(manifest, bundlePathOrHandler, input, {
        ...mergedOptions,
        sessionId: invocationId,
      });
    }

    const denoAvailable = isDenoAvailable(mergedOptions.denoExecutable);
    if (mode === "auto" && !denoAvailable) {
      if (isTestRuntime && mergedOptions.allowUnsafeVmFallback) {
        return await DeterministicWorkerSandbox.execute(manifest, bundlePathOrHandler, input, {
          ...mergedOptions,
          sessionId: invocationId,
        });
      }
      throw new Error(
        "Production tool execution requires Deno; unsafe Node VM fallback is disabled",
      );
    }

    if (mode === "deno" || mode === "auto") {
      if (!denoAvailable) {
        throw new Error(
          `Deno executable '${mergedOptions.denoExecutable ?? "deno"}' is not available`,
        );
      }

      let brokerHandler = mergedOptions.brokerHandler;
      if (!brokerHandler && brokerManager) {
        brokerHandler = brokerManager.createRequestHandler({
          invocationId,
          grant: mergedOptions.grant,
          workspaceRoot: mergedOptions.workspaceRoot ?? process.cwd(),
          sessionId: mergedOptions.sessionId,
          workspaceId: mergedOptions.workspaceId,
          toolId: toolName,
          toolVersion,
        });
      }

      const workerProcess = new WorkerProcess({
        manifest,
        bundleEntrypoint: bundlePathOrHandler,
        workspaceRoot: mergedOptions.workspaceRoot,
        environment: mergedOptions.environment,
        timeoutMs: mergedOptions.timeoutMs,
        memoryLimitMb: mergedOptions.memoryLimitMb,
        maxOutputSizeBytes: mergedOptions.maxOutputSizeBytes,
        denoExecutable: mergedOptions.denoExecutable,
        brokerHandler,
        onProgress: mergedOptions.onProgress,
        onLog: mergedOptions.onLog,
      });

      try {
        const workerRes = await workerProcess.execute(invocationId, input, {
          sessionId: mergedOptions.sessionId,
          workspaceId: mergedOptions.workspaceId,
          toolId: toolName,
          version: toolVersion,
        });
        if (brokerManager) {
          const valRes = brokerManager.finalizeInvocation(invocationId, {
            maxMemoryBytes: workerRes.resourceUsage?.memoryBytes,
            cpuTimeMs: workerRes.resourceUsage?.cpuTimeMs,
            wallDurationMs: workerRes.durationMs,
          });
          if (!valRes.success) {
            return {
              status: "error",
              error: {
                type: "boundary_violation",
                message:
                  valRes.violations?.join("; ") ??
                  "Invocation failed qualification boundary checks",
                details: {
                  violations: valRes.violations,
                  quarantineRecord: valRes.quarantineRecord,
                },
              },
              durationMs: workerRes.durationMs,
              resourceUsage: workerRes.resourceUsage,
              logs: workerRes.logs,
              progress: workerRes.progress,
            };
          }
        }
        return {
          status: workerRes.status,
          output: workerRes.output,
          error: workerRes.error,
          durationMs: workerRes.durationMs,
          resourceUsage: workerRes.resourceUsage,
          logs: workerRes.logs,
          progress: workerRes.progress,
        };
      } finally {
        if (brokerManager) {
          brokerManager.cleanupInvocation(invocationId);
        }
      }
    }

    throw new Error(`Unsupported execution mode '${mode}'`);
  }
}
