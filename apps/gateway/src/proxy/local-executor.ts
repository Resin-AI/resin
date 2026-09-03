import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityManifestSchema,
  type CommandCapability,
  type FsCapability,
  type ToolManifest,
  ToolManifestSchema,
  canonicalJson,
  normalizeSha256,
} from "@resin/contracts";
import {
  type ArtifactCache,
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_SIGNATURE,
  BundleSignatureDataSchema,
  CapabilityBrokerManager,
  type CapabilityPolicyEngine,
  type KeyStore,
  ToolBundleLoader,
  WorkerProcess,
  createInvocationGrant,
  verifyBundleSignature,
} from "@resin/runtime";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import { computeManifestDigest, computeSha256 } from "../registry/validator.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

export interface LocalArtifactEntry {
  toolId: string;
  name?: string;
  version?: string;
  artifactDigest: string;
  manifestDigest?: string;
  status?: string;
  signatureIdentity?: {
    keyId: string;
    algorithm?: string;
  };
}

export interface LocalArtifactExecuteParams {
  entry: LocalArtifactEntry;
  manifest?: ToolManifest;
  parameters: JsonRpcParams;
  context: WorkspaceContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: number, total?: number) => void;
}

export interface LocalArtifactExecutorOptions {
  cache: ArtifactCache;
  loader?: ToolBundleLoader | (() => ToolBundleLoader);
  workspaceRoot?: string;
  brokerManager?: CapabilityBrokerManager;
  policyEngine?: CapabilityPolicyEngine;
  keyStore?: KeyStore;
  allowDevKeys?: boolean;
  development?: boolean;
  denoExecutable?: string;
  resinHome?: string;
  requireSignature?: boolean;
}

function checkExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export function resolveDenoExecutable(options?: {
  denoExecutable?: string;
  resinHome?: string;
}): string | undefined {
  // 1. Explicit denoExecutable option
  if (options?.denoExecutable && checkExecutable(options.denoExecutable)) {
    return options.denoExecutable;
  }

  // 2. RESIN_DENO_EXECUTABLE env
  const envDeno = process.env.RESIN_DENO_EXECUTABLE;
  if (envDeno && checkExecutable(envDeno)) {
    return envDeno;
  }

  // 3. <resinHome>/current/deno/deno[.exe] where resinHome = RESIN_HOME env or ~/.resin
  const resinHome =
    options?.resinHome || process.env.RESIN_HOME || path.join(os.homedir(), ".resin");
  const resinDeno = path.join(
    resinHome,
    "current",
    "deno",
    process.platform === "win32" ? "deno.exe" : "deno",
  );
  if (checkExecutable(resinDeno)) {
    return resinDeno;
  }
  if (process.platform === "win32") {
    const resinDenoFallback = path.join(resinHome, "current", "deno", "deno");
    if (checkExecutable(resinDenoFallback)) {
      return resinDenoFallback;
    }
  }

  // 4. PATH lookup
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    if (!p) continue;
    const candidate = path.join(p, process.platform === "win32" ? "deno.exe" : "deno");
    if (checkExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function findDenoBinary(
  options?: { denoExecutable?: string; resinHome?: string } | string,
): string {
  const opts = typeof options === "string" ? { denoExecutable: options } : options;
  return resolveDenoExecutable(opts) ?? opts?.denoExecutable ?? "deno";
}

function scanArtifactForBareImports(
  entrypointPath: string,
  artifactDir: string,
): { bareImports: string[]; errors: string[] } {
  const visitedFiles = new Set<string>();
  const filesToScan: string[] = [path.resolve(entrypointPath)];
  const bareImports = new Set<string>();
  const errors: string[] = [];

  const resolvedArtifactDir = path.resolve(artifactDir);

  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  while (filesToScan.length > 0) {
    const currentFile = filesToScan.pop()!;
    if (visitedFiles.has(currentFile)) continue;
    visitedFiles.add(currentFile);

    if (!fs.existsSync(currentFile)) {
      continue;
    }

    let source = "";
    try {
      source = fs.readFileSync(currentFile, "utf8");
    } catch (err) {
      errors.push(
        `Failed to read file '${currentFile}': ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const specifiers = new Set<string>();
    for (const pat of patterns) {
      pat.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pat.exec(source)) !== null) {
        if (match[1]) {
          specifiers.add(match[1]);
        }
      }
    }

    for (const spec of specifiers) {
      const isRelative = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/");
      if (isRelative) {
        const currentDir = path.dirname(currentFile);
        const resolvedTarget = path.resolve(currentDir, spec);
        if (
          resolvedTarget === resolvedArtifactDir ||
          resolvedTarget.startsWith(resolvedArtifactDir + path.sep)
        ) {
          const candidates = [
            resolvedTarget,
            `${resolvedTarget}.ts`,
            `${resolvedTarget}.js`,
            path.join(resolvedTarget, "index.ts"),
            path.join(resolvedTarget, "index.js"),
          ];
          for (const cand of candidates) {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              if (!visitedFiles.has(cand)) {
                filesToScan.push(cand);
              }
              break;
            }
          }
        }
      } else {
        bareImports.add(spec);
      }
    }
  }

  return {
    bareImports: Array.from(bareImports),
    errors,
  };
}

function matchesManifestDigest(manifest: ToolManifest, expectedDigest: string): boolean {
  const normExpected = normalizeSha256(expectedDigest, false);
  const digest1 = normalizeSha256(computeManifestDigest(manifest), false);
  if (digest1 === normExpected) return true;
  const digest2 = normalizeSha256(computeSha256(canonicalJson(manifest)), false);
  if (digest2 === normExpected) return true;
  if (manifest.digest && normalizeSha256(manifest.digest, false) === normExpected) return true;
  return false;
}

export class LocalArtifactExecutor {
  readonly cache: ArtifactCache;
  private readonly loaderInstance?: ToolBundleLoader | (() => ToolBundleLoader);
  private workspaceRoot: string;
  private readonly brokerManager?: CapabilityBrokerManager;
  private readonly policyEngine?: CapabilityPolicyEngine;
  private readonly keyStore?: KeyStore;
  private readonly allowDevKeys: boolean;
  private readonly development: boolean;
  private readonly denoExecutable?: string;
  private readonly resinHome?: string;
  private readonly requireSignature?: boolean;

  constructor(options: LocalArtifactExecutorOptions) {
    this.cache = options.cache;
    this.loaderInstance = options.loader;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.brokerManager = options.brokerManager;
    this.policyEngine = options.policyEngine;
    this.keyStore = options.keyStore;
    this.allowDevKeys = options.allowDevKeys ?? false;
    this.development = options.development ?? options.allowDevKeys ?? true;
    this.denoExecutable = options.denoExecutable;
    this.resinHome = options.resinHome;
    this.requireSignature = options.requireSignature;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  private getLoader(): ToolBundleLoader {
    if (typeof this.loaderInstance === "function") {
      return this.loaderInstance();
    }
    if (this.loaderInstance) {
      return this.loaderInstance;
    }
    return new ToolBundleLoader({
      cache: this.cache,
      keyStore: this.keyStore,
      allowDevKeys: this.allowDevKeys,
      development: this.development,
    });
  }

  canExecute(entry: { toolId: string; version?: string; artifactDigest?: string }): boolean {
    if (!entry || !entry.artifactDigest) {
      return false;
    }

    if (!this.cache.isArtifactCached(entry.artifactDigest)) {
      return false;
    }

    const manifest = this.cache.getArtifactManifest(entry.artifactDigest);
    if (!manifest) {
      return false;
    }

    if (entry.toolId && manifest.id !== entry.toolId) {
      return false;
    }

    if (entry.version && manifest.version !== entry.version) {
      return false;
    }

    return true;
  }

  async execute(params: LocalArtifactExecuteParams): Promise<CallToolResult> {
    const { entry, parameters, context } = params;
    const artifactDir = this.cache.getArtifactPath(entry.artifactDigest);

    if (!fs.existsSync(artifactDir)) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Artifact directory does not exist for digest '${entry.artifactDigest}'`,
          },
        ],
      };
    }

    // 1. Resolve and validate manifest
    let manifest = params.manifest;
    if (!manifest) {
      manifest = this.cache.getArtifactManifest(entry.artifactDigest) ?? undefined;
    }
    if (!manifest) {
      const manifestPath = path.join(artifactDir, BUNDLE_FILE_MANIFEST);
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = fs.readFileSync(manifestPath, "utf8");
          manifest = ToolManifestSchema.parse(JSON.parse(raw));
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to parse manifest in artifact '${artifactDir}': ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      }
    }

    if (!manifest) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool bundle is missing required ${BUNDLE_FILE_MANIFEST}`,
          },
        ],
      };
    }

    // 2. Fail closed on manifest digest mismatch
    if (entry.manifestDigest && !matchesManifestDigest(manifest, entry.manifestDigest)) {
      const computed = computeManifestDigest(manifest);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Manifest digest mismatch: expected ${entry.manifestDigest}, computed ${computed}`,
          },
        ],
      };
    }

    // 3. Extracted metadata integrity check
    const metaPath = path.join(artifactDir, ".extracted");
    if (fs.existsSync(metaPath)) {
      try {
        const metaContent = fs.readFileSync(metaPath, "utf8");
        const meta = JSON.parse(metaContent) as { digest?: string; verified?: boolean };
        if (meta.digest) {
          const normMeta = normalizeSha256(meta.digest, false);
          const normEntry = normalizeSha256(entry.artifactDigest, false);
          if (normMeta !== normEntry) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Artifact digest mismatch in extraction metadata: expected ${entry.artifactDigest}, got ${meta.digest}`,
                },
              ],
            };
          }
        }
      } catch {
        // Non-fatal if metadata is malformed, other checks verify contents
      }
    }

    // 4. Resolve entrypoint file
    const entrypointTs = path.join(artifactDir, BUNDLE_FILE_ENTRYPOINT_TS);
    const entrypointJs = path.join(artifactDir, BUNDLE_FILE_ENTRYPOINT_JS);
    const entrypointPath = fs.existsSync(entrypointTs)
      ? entrypointTs
      : fs.existsSync(entrypointJs)
        ? entrypointJs
        : undefined;

    if (!entrypointPath) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool bundle is missing entrypoint file (${BUNDLE_FILE_ENTRYPOINT_TS} or ${BUNDLE_FILE_ENTRYPOINT_JS})`,
          },
        ],
      };
    }

    // 5. Signature verification as required
    const sigPath = path.join(artifactDir, BUNDLE_FILE_SIGNATURE);
    const hasSig = fs.existsSync(sigPath);
    const loader = this.getLoader();
    const keyStore = this.keyStore ?? loader.keyStore;
    const shouldRequireSig = this.requireSignature ?? Boolean(entry.signatureIdentity?.keyId);
    if (shouldRequireSig && !hasSig) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Bundle signature is required in production but signature.json is missing",
          },
        ],
      };
    }

    if (hasSig) {
      try {
        const sigContent = fs.readFileSync(sigPath, "utf8");
        const sigData = BundleSignatureDataSchema.parse(JSON.parse(sigContent));
        if (entry.signatureIdentity?.keyId && sigData.keyId !== entry.signatureIdentity.keyId) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Signature keyId '${sigData.keyId}' does not match expected keyId '${entry.signatureIdentity.keyId}'`,
              },
            ],
          };
        }
        if (keyStore) {
          const verifyResult = await verifyBundleSignature(sigData, keyStore, {
            allowDevKeys: this.allowDevKeys,
          });
          if (!verifyResult.valid) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Bundle signature verification failed: ${verifyResult.error ?? verifyResult.reason}`,
                },
              ],
            };
          }
        }
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Bundle signature inspection failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }

    // 6. Set up invocation workspace root and capabilities
    const workspaceRoot = path.resolve(
      context.projectRoot ??
        context.canonicalRoot ??
        (context.lockPath ? path.dirname(path.dirname(context.lockPath)) : undefined) ??
        context.roots?.[0]?.path ??
        this.workspaceRoot,
    );
    const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const manifestCaps = manifest.capabilities ?? {};
    const allowShell = manifestCaps.command?.allowShellExecution === true;

    const commandCap: CommandCapability = {
      allowShellExecution: allowShell,
      allowedCommands: manifestCaps.command?.allowedCommands ?? [],
      allowedBinaries: manifestCaps.command?.allowedBinaries ?? [],
      forbiddenPatterns: manifestCaps.command?.forbiddenPatterns ?? [],
      allowEnvPassthrough: manifestCaps.command?.allowEnvPassthrough ?? [],
    };

    const fsCap: FsCapability = {
      allowWorkspaceRoot: true,
      allowTemp: true,
      readPaths: [workspaceRoot, ...(manifestCaps.fs?.readPaths ?? [])],
      writePaths: [workspaceRoot, ...(manifestCaps.fs?.writePaths ?? [])],
      denyPaths: manifestCaps.fs?.denyPaths ?? [],
      maxFileSizeBytes: manifestCaps.fs?.maxFileSizeBytes ?? 10485760,
    };

    const grant = createInvocationGrant({
      invocationId,
      toolId: manifest.id,
      toolVersion: manifest.version,
      workspaceId: context.workspaceId ?? "default",
      envelopeId: `env_${invocationId}`,
      capabilities: CapabilityManifestSchema.parse({
        ...manifestCaps,
        fs: fsCap,
        command: commandCap,
      }),
    });

    const brokerManager =
      this.brokerManager ??
      new CapabilityBrokerManager({
        requireGrant: true,
        allowUnverifiedBoundaries: true,
        development: true,
      });

    const brokerHandler = brokerManager.createRequestHandler({
      invocationId,
      grant,
      workspaceRoot,
      sessionId: context.sessionId,
      workspaceId: context.workspaceId,
      toolId: manifest.id,
      toolVersion: manifest.version,
    });

    // 7. Validate artifact imports
    // Fail closed before spawning Deno if the artifact's entry (src/index.ts and any relative imports
    // under the artifact directory) contains a bare import other than "@resin/runtime".
    const { bareImports, errors: scanErrors } = scanArtifactForBareImports(
      entrypointPath,
      artifactDir,
    );
    if (scanErrors.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to inspect artifact imports: ${scanErrors.join("; ")}`,
          },
        ],
      };
    }

    const offendingImports = bareImports.filter((spec) => spec !== "@resin/runtime");
    if (offendingImports.length > 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Artifact contains unsupported bare import(s): ${offendingImports.join(", ")}. Only '@resin/runtime' is supported.`,
          },
        ],
      };
    }

    // 8. Determine timeout and resource limits from manifest
    const timeoutMs =
      params.timeoutMs ?? manifest.limits?.timeoutMs ?? manifest.runtime?.timeoutMs ?? 30000;

    const memoryLimitMb = manifest.limits?.maxMemoryBytes
      ? Math.floor(manifest.limits.maxMemoryBytes / (1024 * 1024))
      : (manifest.runtime?.memoryLimitMb ?? 128);

    const maxOutputSizeBytes =
      manifest.limits?.maxOutputBytes ?? manifest.runtime?.maxOutputSizeBytes ?? 1024 * 1024;

    const worker = new WorkerProcess({
      manifest,
      bundleEntrypoint: entrypointPath,
      workspaceRoot,
      capabilities: grant.capabilities,
      timeoutMs,
      memoryLimitMb,
      maxOutputSizeBytes,
      denoExecutable: findDenoBinary({
        denoExecutable: this.denoExecutable,
        resinHome: this.resinHome,
      }),
      brokerHandler,
      importMap: {},
      onProgress: (prog) => {
        params.onProgress?.(prog.percentage, 100);
      },
    });

    if (params.signal?.aborted) {
      return {
        isError: true,
        content: [{ type: "text", text: "Tool invocation was cancelled." }],
      };
    }

    const onAbort = () => {
      worker.sendCancel(invocationId, "Tool invocation cancelled by caller");
      worker.forceKill();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const result = await worker.execute(invocationId, parameters, {
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        toolId: manifest.id,
        version: manifest.version,
      });

      if (result.status === "success") {
        const text =
          typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      }

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: result.error?.message ?? `Tool execution failed with status: ${result.status}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      brokerManager.cleanupInvocation(invocationId);
    }
  }
}
