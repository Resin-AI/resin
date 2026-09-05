import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {
  type CanonicalJsonRecord,
  type CanonicalJsonValue,
  type ToolManifest,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import ts from "typescript";
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
import {
  type TokenCarrier,
  getVerifiedQualificationData,
  isVerifiedQualificationToken,
} from "../monitor/token.js";
import type { InvocationGrant } from "../policy/grant.js";
import { validateAgainstSchema } from "./bootstrap.js";
import { WorkerProcess } from "./process.js";
import {
  type LogMessage,
  type ProgressMessage,
  createLogMessage,
  createProgressMessage,
  withResolvers,
} from "./protocol.js";
import { type BrokerRequestHandlerFn, type ToolContext, createToolContext } from "./sdk.js";
import { TOOL_SDK_SHIM_SOURCE } from "./tool-sdk-shim.js";

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
  output?: CanonicalJsonValue;
  error?: {
    type: string;
    message: string;
    stack?: string;
    details?: CanonicalJsonValue;
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
 * Helper to check if Deno binary is available on PATH.
 */
function isDenoAvailable(denoExecutable?: string): boolean {
  try {
    const cmd = denoExecutable ?? "deno";
    const res = spawnSync(cmd, ["--version"], { stdio: "ignore" });
    return res.status === 0;
  } catch {
    return false;
  }
}

// Published artifacts stay ESM for Deno. Convert only at the Node VM boundary.
function compileVmModule(source: string, fileName: string): string {
  const result = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      allowJs: true,
    },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(
      errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "),
    );
  }
  return result.outputText;
}

const SANDBOX_SDK_MODULE = compileVmModule(TOOL_SDK_SHIM_SOURCE, "resin-runtime.js");

/**
 * In-process deterministic VM execution environment for running tools in isolated contexts.
 */
export class DeterministicWorkerSandbox {
  /**
   * Executes a tool handler or bundle entrypoint in an isolated, permissionless context.
   */
  static async execute(
    manifest: ToolManifest | CanonicalJsonRecord,
    bundleOrHandler:
      | string
      | ((ctx: ToolContext) => CanonicalJsonValue | Promise<CanonicalJsonValue>),
    input: CanonicalJsonValue,
    options: ToolExecutionOptions = {},
  ): Promise<InvocationResult> {
    const startTime = Date.now();
    const invocationId =
      options.grant?.invocationId ??
      options.sessionId ??
      `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    // SAFETY: Tag check confirms manifest is a record.
    const manifestRecord =
      manifest && manifest instanceof Object && !Array.isArray(manifest)
        ? (manifest as CanonicalJsonRecord)
        : {};
    // SAFETY: Tag check confirms manifestRecord.limits is a record.
    const manifestLimits =
      manifestRecord.limits &&
      manifestRecord.limits instanceof Object &&
      !Array.isArray(manifestRecord.limits)
        ? (manifestRecord.limits as CanonicalJsonRecord)
        : {};
    // SAFETY: Number.isFinite check confirms manifestLimits.timeoutMs is a number.
    const timeoutMs =
      options.timeoutMs ??
      (Number.isFinite(manifestLimits.timeoutMs) ? (manifestLimits.timeoutMs as number) : 30000);
    const logs: LogMessage[] = [];
    const progressList: ProgressMessage[] = [];

    // Create unique scratch directory
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "te-sandbox-"));

    const onLog = (
      level: "debug" | "info" | "warn" | "error",
      message: string,
      data?: CanonicalJsonValue,
    ) => {
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
    let rawOutput: CanonicalJsonValue = null;

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
      if (manifest && manifest instanceof Object && !Array.isArray(manifest)) {
        // SAFETY: Tag check confirms manifest is a non-null object record.
        const manifestRec = manifest as CanonicalJsonRecord;
        if (manifestRec.id) {
          toolName = String(manifestRec.id);
        } else if (manifestRec.name) {
          toolName = String(manifestRec.name);
        }
        if (manifestRec.version) {
          toolVersion = String(manifestRec.version);
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
        // SAFETY: manifest is cast to CanonicalJsonRecord to safely access optional token properties if present.
        const qualToken =
          options.token ??
          options.qualificationToken ??
          options.loadedBundle?.qualificationToken ??
          (manifest && manifest instanceof Object && isVerifiedQualificationToken(manifest)
            ? manifest
            : ((manifest as CanonicalJsonRecord)?.qualificationToken ??
              (manifest as CanonicalJsonRecord)?.token));

        // SAFETY: Tag check confirms qualToken is a non-null object record for token verification candidate.
        const qualTokenCandidate =
          qualToken && qualToken instanceof Object
            ? (qualToken as VerifiedQualificationToken | TokenCarrier | object)
            : undefined;
        const isVerifiedToken =
          qualTokenCandidate !== undefined && isVerifiedQualificationToken(qualTokenCandidate);

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
            // SAFETY: isVerifiedQualificationToken guard validates qualToken before casting.
            token: isVerifiedToken ? (qualTokenCandidate as VerifiedQualificationToken) : undefined,
            // SAFETY: isVerifiedQualificationToken or defaultBoundaries provides a valid boundary token.
            boundaries: isVerifiedToken
              ? (qualTokenCandidate as VerifiedQualificationToken)
              : (options.defaultBoundaries as VerifiedQualificationToken | undefined),
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
      let handler: (ctx: ToolContext) => CanonicalJsonValue | Promise<CanonicalJsonValue>;

      const isHandlerFunction =
        Object.prototype.toString.call(bundleOrHandler) === "[object Function]" ||
        Object.prototype.toString.call(bundleOrHandler) === "[object AsyncFunction]";

      if (isHandlerFunction) {
        // SAFETY: Object tag check confirms bundleOrHandler is a function handler.
        handler = bundleOrHandler as (
          ctx: ToolContext,
        ) => CanonicalJsonValue | Promise<CanonicalJsonValue>;
      } else {
        // SAFETY: Earlier branch handled function handlers; bundleOrHandler is a string path or source.
        const bundlePath = bundleOrHandler as string;
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
          fileContent = bundlePath; // treated as inline JS source code
        }

        handler = this.compileSandboxedHandler(fileContent, options);
      }

      // 4. Run handler with timeout
      const {
        promise: execPromise,
        resolve: execResolve,
        reject: execReject,
      } = withResolvers<CanonicalJsonValue>();

      const timer = setTimeout(() => {
        execReject(new Error(`Execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const handlerResult = handler(toolContext);
        const resTag = Object.prototype.toString.call(handlerResult);
        // SAFETY: Tag check and then property check confirm handlerResult is a Promise or thenable.
        const isThenable =
          handlerResult !== null &&
          handlerResult !== undefined &&
          (handlerResult instanceof Promise ||
            resTag === "[object Promise]" ||
            ((resTag === "[object Object]" || resTag === "[object Function]") &&
              "then" in (handlerResult as object) &&
              (Object.prototype.toString.call((handlerResult as CanonicalJsonRecord).then) ===
                "[object Function]" ||
                Object.prototype.toString.call((handlerResult as CanonicalJsonRecord).then) ===
                  "[object AsyncFunction]")));
        if (isThenable) {
          // SAFETY: Promise check or thenable object tag check confirms handlerResult is a Promise.
          (handlerResult as Promise<CanonicalJsonValue>)
            .then((res) => execResolve(res))
            .catch((err) => execReject(err instanceof Error ? err : new Error(String(err))));
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
            details: {
              violations: valRes.violations,
              quarantineRecord: valRes.quarantineRecord
                ? {
                    quarantineId: valRes.quarantineRecord.quarantineId,
                    reason: valRes.quarantineRecord.reason,
                    violationType: valRes.quarantineRecord.violationType,
                    details: valRes.quarantineRecord.details,
                  }
                : undefined,
            },
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
  ): (ctx: ToolContext) => CanonicalJsonValue | Promise<CanonicalJsonValue> {
    const sandboxExports: CanonicalJsonRecord = {};
    const sandboxModule = { exports: sandboxExports };

    const transformedCode = compileVmModule(code, "bundle-entrypoint.ts");

    // Strict permissionless sandbox environment
    const sandboxGlobals = {
      module: sandboxModule,
      exports: sandboxExports,
      console: {
        log: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      fetch: () => {
        throw new Error(
          "Permission Denied: direct fetch() is not allowed in permissionless sandbox",
        );
      },
      setTimeout: () => {
        throw new Error("Permission Denied: timers are not allowed in sandbox");
      },
      setInterval: () => {
        throw new Error("Permission Denied: timers are not allowed in sandbox");
      },
      setImmediate: () => {
        throw new Error("Permission Denied: timers are not allowed in sandbox");
      },
      process: {
        env: {},
        cwd: () => "/",
        exit: () => {
          throw new Error("Permission Denied: process.exit is not allowed in sandbox");
        },
      },
      Buffer: {
        from: (val: string | Uint8Array, enc?: BufferEncoding) => {
          if (String(val) === val) {
            // SAFETY: String equality check confirms val is a string primitive.
            return Buffer.from(val as string, enc);
          }
          return Buffer.from(val);
        },
        alloc: (size: number) => Buffer.alloc(Math.min(size, 1024 * 1024)),
      },
    };

    const context = vm.createContext(sandboxGlobals);

    // Apply resource limits if available in current Node environment
    vm.runInContext(
      `
      (function () {
        const module = { exports: {} };
        const exports = module.exports;
        ${SANDBOX_SDK_MODULE}
        const sdk = Object.freeze(module.exports);
        Object.defineProperty(globalThis, "require", {
          value: Object.freeze(function (specifier) {
            if (specifier === "@resin/runtime") return sdk;
            throw new Error("Permission Denied: direct require('" + specifier + "') is not allowed in sandbox");
          }),
          writable: false,
          configurable: false,
        });
      })();
      Object.freeze(Object.prototype);
      Object.freeze(Function.prototype);
      Object.freeze(Array.prototype);
    `,
      context,
      {
        timeout: 1000,
      },
    );

    const script = new vm.Script(transformedCode, {
      filename: "bundle-entrypoint.js",
    });

    script.runInContext(context, {
      timeout: options.timeoutMs ?? 30000,
    });

    const candidate = sandboxModule.exports;
    let handler: unknown;

    const candidateTag = Object.prototype.toString.call(candidate);
    if (candidateTag === "[object Function]" || candidateTag === "[object AsyncFunction]") {
      handler = candidate;
    } else if (candidate && candidate instanceof Object && !Array.isArray(candidate)) {
      // SAFETY: Object tag check confirms candidate is a record of export bindings.
      const record = candidate as CanonicalJsonRecord;
      const defaultTag = Object.prototype.toString.call(record.default);
      const handlerTag = Object.prototype.toString.call(record.handler);
      const runTag = Object.prototype.toString.call(record.run);
      const executeTag = Object.prototype.toString.call(record.execute);

      if (defaultTag === "[object Function]" || defaultTag === "[object AsyncFunction]") {
        handler = record.default;
      } else if (handlerTag === "[object Function]" || handlerTag === "[object AsyncFunction]") {
        handler = record.handler;
      } else if (runTag === "[object Function]" || runTag === "[object AsyncFunction]") {
        handler = record.run;
      } else if (executeTag === "[object Function]" || executeTag === "[object AsyncFunction]") {
        handler = record.execute;
      }
    }

    const handlerTag = Object.prototype.toString.call(handler);
    if (handlerTag !== "[object Function]" && handlerTag !== "[object AsyncFunction]") {
      throw new Error(
        "Tool bundle must export a function (default, handler, run, or execute) accepting ToolContext",
      );
    }

    // SAFETY: Tag check confirms handler is a callable function.
    return handler as (ctx: ToolContext) => CanonicalJsonValue | Promise<CanonicalJsonValue>;
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
    }
  }

  /**
   * Executes a tool defined by manifest and bundle/handler in an isolated sandbox.
   */
  async executeTool(
    manifest: ToolManifest | CanonicalJsonRecord,
    bundlePathOrHandler:
      | string
      | ((ctx: ToolContext) => CanonicalJsonValue | Promise<CanonicalJsonValue>),
    input: CanonicalJsonValue,
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
    if (manifest && manifest instanceof Object && !Array.isArray(manifest)) {
      // SAFETY: Tag check confirms manifest is a non-null object record.
      const manifestRec = manifest as CanonicalJsonRecord;
      if (manifestRec.id) {
        toolName = String(manifestRec.id);
      } else if (manifestRec.name) {
        toolName = String(manifestRec.name);
      }
      if (manifestRec.version) {
        toolVersion = String(manifestRec.version);
      }
    }

    // Extract verified qualification token from options or manifest or loaded bundle
    // SAFETY: manifest is cast to CanonicalJsonRecord to safely access optional token properties if present.
    const qualToken =
      mergedOptions.token ??
      mergedOptions.qualificationToken ??
      mergedOptions.loadedBundle?.qualificationToken ??
      (manifest && manifest instanceof Object && isVerifiedQualificationToken(manifest)
        ? manifest
        : ((manifest as CanonicalJsonRecord)?.qualificationToken ??
          (manifest as CanonicalJsonRecord)?.token));
    // SAFETY: Tag check confirms qualToken is a non-null object record for token verification candidate.
    const qualTokenCandidate =
      qualToken && qualToken instanceof Object
        ? (qualToken as VerifiedQualificationToken | TokenCarrier | object)
        : undefined;
    const isVerifiedToken =
      qualTokenCandidate !== undefined && isVerifiedQualificationToken(qualTokenCandidate);
    let actualDependencies: Record<string, string> | undefined;
    let actualSourceDigest: string | undefined;

    // Verify token identity, source, schema, and dependencies against manifest and entrypoint
    if (qualTokenCandidate && isVerifiedToken) {
      const verifiedData = getVerifiedQualificationData(qualTokenCandidate);
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
        if (String(bundlePathOrHandler) === bundlePathOrHandler) {
          // SAFETY: String equality check confirms bundlePathOrHandler is a string primitive.
          const bundlePathStr = bundlePathOrHandler as string;
          let sourceContent: string | null = null;
          let bundleDir: string | null = null;

          if (fs.existsSync(bundlePathStr)) {
            const stat = fs.statSync(bundlePathStr);
            if (stat.isDirectory()) {
              bundleDir = bundlePathStr;
              const entryTs = path.join(bundlePathStr, "src/index.ts");
              const entryJs = path.join(bundlePathStr, "src/index.js");
              const entryDirect = path.join(bundlePathStr, "index.js");
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
                throw new Error(`Cannot find entrypoint in bundle directory: ${bundlePathStr}`);
              }
            } else {
              bundleDir = path.dirname(bundlePathStr);
              sourceContent = fs.readFileSync(bundlePathStr, "utf-8");
            }
          } else {
            sourceContent = bundlePathStr; // treated as inline code
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
              let pkgParsed: CanonicalJsonRecord = {};
              try {
                pkgParsed = JSON.parse(pkgContent);
              } catch (err) {
                throw new Error(
                  `Invalid package.json in bundle directory: ${err instanceof Error ? err.message : String(err)}`,
                );
              }

              // SAFETY: Tag check confirms pkgParsed.dependencies is an object record.
              const rawDeps =
                pkgParsed.dependencies &&
                pkgParsed.dependencies instanceof Object &&
                !Array.isArray(pkgParsed.dependencies)
                  ? (pkgParsed.dependencies as CanonicalJsonRecord)
                  : {};
              const deps: Record<string, string> = {};
              for (const [k, v] of Object.entries(rawDeps)) {
                if (String(v) === v) {
                  // SAFETY: String equality check confirms v is a string primitive.
                  deps[k] = v as string;
                }
              }
              actualDependencies = deps;

              const expectedDep = normalizeSha256(verifiedData.depDigest, false);

              if (fs.existsSync(lockPath)) {
                const lockContent = fs.readFileSync(lockPath, "utf-8");
                let lockParsed: CanonicalJsonRecord = {};
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
      isVerifiedToken ||
      mergedOptions.defaultBoundaries ||
      mergedOptions.development ||
      mergedOptions.allowUnverifiedBoundaries
    ) {
      brokerManager.registerInvocation({
        invocationId,
        toolId: toolName,
        toolVersion,
        // SAFETY: isVerifiedQualificationToken guard validates qualToken before casting.
        token: isVerifiedToken ? (qualTokenCandidate as VerifiedQualificationToken) : undefined,
        // SAFETY: isVerifiedQualificationToken or defaultBoundaries provides a valid boundary token.
        boundaries: isVerifiedToken
          ? (qualTokenCandidate as VerifiedQualificationToken)
          : (mergedOptions.defaultBoundaries as VerifiedQualificationToken | undefined),
        externalAuthorizations: mergedOptions.externalAuthorizations,
        authorizationVerifier: mergedOptions.authorizationVerifier,
        workspaceRoot: mergedOptions.workspaceRoot,
        actualSourceDigest,
        actualDependencies,
      });
    }

    const isTestRuntime = Boolean(process.env.VITEST || process.env.VITEST_WORKER_ID);
    const mode = mergedOptions.mode ?? (isTestRuntime ? "sandbox-vm" : "deno");

    const isBundleHandlerFunction =
      Object.prototype.toString.call(bundlePathOrHandler) === "[object Function]" ||
      Object.prototype.toString.call(bundlePathOrHandler) === "[object AsyncFunction]";

    if (isBundleHandlerFunction) {
      if (mode !== "in-process" && mode !== "sandbox-vm") {
        throw new Error(
          "Direct function handlers are test-only and cannot execute in Deno production mode",
        );
      }
      if (!isTestRuntime && !mergedOptions.allowUnsafeVmFallback) {
        throw new Error(
          "Direct function handlers are not allowed in production without allowUnsafeVmFallback: true",
        );
      }
      return DeterministicWorkerSandbox.execute(
        manifest,
        bundlePathOrHandler,
        input,
        mergedOptions,
      );
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
        // SAFETY: Function handlers were handled by earlier isBundleHandlerFunction branch; bundlePathOrHandler is a string entrypoint.
        bundleEntrypoint: bundlePathOrHandler as string,
        workspaceRoot: mergedOptions.workspaceRoot,
        environment: mergedOptions.environment,
        timeoutMs: mergedOptions.timeoutMs,
        memoryLimitMb: mergedOptions.memoryLimitMb,
        maxOutputSizeBytes: mergedOptions.maxOutputSizeBytes,
        brokerHandler,
        denoExecutable: mergedOptions.denoExecutable,
        onLog: mergedOptions.onLog,
        onProgress: mergedOptions.onProgress,
      });

      const execResult = await workerProcess.execute(invocationId, input, {
        sessionId: mergedOptions.sessionId,
        workspaceId: mergedOptions.workspaceId,
        toolId: toolName,
        version: toolVersion,
      });

      // SAFETY: Output and error from worker process execution are cast to InvocationResult contract types.
      return {
        status: execResult.status,
        output: execResult.output as CanonicalJsonValue,
        error: execResult.error as InvocationResult["error"],
        durationMs: execResult.durationMs,
        resourceUsage: execResult.resourceUsage,
        logs: execResult.logs,
        progress: execResult.progress,
      };
    }
    if (mode === "sandbox-vm" || mode === "in-process") {
      return await DeterministicWorkerSandbox.execute(manifest, bundlePathOrHandler, input, {
        ...mergedOptions,
        sessionId: invocationId,
      });
    }

    throw new Error(`Unsupported execution mode: ${mode}`);
  }
}
