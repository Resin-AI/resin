import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityManifestSchema,
  type CommandCapability,
  type FsCapability,
  type RecordedWorkflow,
  type ToolManifest,
  ToolManifestSchema,
  type WorkflowJsonValue,
  canonicalJson,
  normalizeSha256,
  validateRecordedWorkflow,
} from "@resin/contracts";
import {
  FilePrivateValueStore,
  RESIN_INVOKE_TOOL_RUNTIME,
  resolvePrivateReference,
} from "@resin/observer";
import {
  type ArtifactCache,
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_SIGNATURE,
  BundleSignatureDataSchema,
  CapabilityBrokerManager,
  type CapabilityPolicyEngine,
  type CompiledWorkflowArtifact,
  DEFAULT_BUNDLE_LIMITS,
  type KeyStore,
  RuntimeAdapterRegistry,
  ToolBundleLoader,
  WorkerProcess,
  createInvocationGrant,
  encodeDeterministicTar,
  instantiateRecordedWorkflow,
  validateBundleEntryPath,
  verifyBundleSignature,
} from "@resin/runtime";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import { computeManifestDigest, computeSha256 } from "../registry/validator.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CommandFailureDiagnostics } from "./command-failures.js";
import type { ManagedToolAccess } from "./tool-access.js";

import { composedResultValue } from "../meta/invoke-tool.js";

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
  /**
   * Dispatches a recorded workflow's step to its callable through the same routing the
   * original call used. Required for `recorded-workflow` artifacts; without it a plan
   * cannot execute and the call reports that honestly.
   */
  stepInvoker?: (request: {
    name: string;
    connection?: string;
    parameters: Record<string, unknown>;
    context: WorkspaceContext;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<CallToolResult>;
  /** Store private workflow references resolve against; defaults to the daemon store. */
  privateValueStore?: {
    get(key: string): unknown | undefined;
    set(key: string, value: unknown): void;
  };
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
  try {
    const normExpected = normalizeSha256(expectedDigest, false);
    const digest1 = normalizeSha256(computeManifestDigest(manifest), false);
    if (digest1 === normExpected) return true;
    const digest2 = normalizeSha256(computeSha256(canonicalJson(manifest)), false);
    if (digest2 === normExpected) return true;
    if (manifest.digest && normalizeSha256(manifest.digest, false) === normExpected) return true;
    return false;
  } catch {
    return false;
  }
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
  private readonly stepInvoker?: LocalArtifactExecutorOptions["stepInvoker"];
  private readonly privateValueStore?: LocalArtifactExecutorOptions["privateValueStore"];
  private managedToolAccess?: ManagedToolAccess;

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
    this.stepInvoker = options.stepInvoker;
    this.privateValueStore = options.privateValueStore;
  }

  setManagedToolAccess(access: ManagedToolAccess): void {
    this.managedToolAccess = access;
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

  private async verifyArtifactDirectory(
    artifactDir: string,
    entry: LocalArtifactEntry,
    manifest: ToolManifest,
    verifyArchiveDigest = true,
  ): Promise<{ verified: boolean; error?: string }> {
    if (!entry.artifactDigest) {
      return { verified: false, error: "Missing artifact digest" };
    }
    try {
      const root = fs.lstatSync(artifactDir);
      if (root.isSymbolicLink() || !root.isDirectory()) {
        return { verified: false, error: "Artifact root must be a regular directory" };
      }
    } catch {
      return { verified: false, error: "Artifact root is unavailable" };
    }

    // 1. Identity must strictly match
    if (manifest.id !== entry.toolId) {
      return {
        verified: false,
        error: `Tool ID mismatch: expected '${entry.toolId}', got '${manifest.id}'`,
      };
    }
    if (entry.version && manifest.version !== entry.version) {
      return {
        verified: false,
        error: `Version mismatch: expected '${entry.version}', got '${manifest.version}'`,
      };
    }
    if (entry.name && manifest.name !== entry.name) {
      return {
        verified: false,
        error: `Name mismatch: expected '${entry.name}', got '${manifest.name}'`,
      };
    }

    // 2. If signature is required or entry declares signatureIdentity, verify signature.json
    const sigPath = path.join(artifactDir, BUNDLE_FILE_SIGNATURE);
    const hasSig = fs.existsSync(sigPath);
    if (this.requireSignature || Boolean(entry.signatureIdentity?.keyId)) {
      if (!hasSig) {
        return {
          verified: false,
          error: "Bundle signature is required in production but signature.json is missing",
        };
      }
    }

    // 3. Collect regular files, enforce bundle limits, reject symlinks and path traversal
    const maxFiles = DEFAULT_BUNDLE_LIMITS.maxFileCount ?? 1000;
    const maxBytes = DEFAULT_BUNDLE_LIMITS.maxBundleSizeBytes ?? 50 * 1024 * 1024;
    const maxSingleFileBytes = DEFAULT_BUNDLE_LIMITS.maxFileSizeBytes ?? 10 * 1024 * 1024;

    const filesToArchive: Array<{ path: string; content: Buffer; executable: boolean }> = [];
    let totalSizeBytes = 0;

    const collectFiles = (currentDir: string, relBase = ""): boolean => {
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return false;
      }

      for (const ent of dirents) {
        const fullPath = path.join(currentDir, ent.name);
        const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;

        try {
          validateBundleEntryPath(relPath);
        } catch {
          return false;
        }

        let lstat: fs.Stats;
        try {
          lstat = fs.lstatSync(fullPath);
        } catch {
          return false;
        }

        if (
          lstat.isSymbolicLink() ||
          lstat.isFIFO() ||
          lstat.isSocket() ||
          lstat.isBlockDevice() ||
          lstat.isCharacterDevice()
        ) {
          return false;
        }

        if (lstat.isDirectory()) {
          if (!collectFiles(fullPath, relPath)) {
            return false;
          }
        } else if (lstat.isFile()) {
          // Exclude only known cache extraction metadata file
          if (relPath === ".extracted") {
            continue;
          }
          if (lstat.size > maxSingleFileBytes) {
            return false;
          }
          totalSizeBytes += lstat.size;
          if (totalSizeBytes > maxBytes) {
            return false;
          }

          let content: Buffer;
          try {
            content = fs.readFileSync(fullPath);
          } catch {
            return false;
          }

          if (content.byteLength !== lstat.size) return false;
          filesToArchive.push({
            path: relPath,
            content,
            executable: (lstat.mode & 0o111) !== 0,
          });
          if (filesToArchive.length > maxFiles) {
            return false;
          }
        } else {
          return false;
        }
      }
      return true;
    };

    if (!collectFiles(artifactDir, "")) {
      return {
        verified: false,
        error: "Artifact directory contains invalid files, symlinks, or exceeds bundle limits",
      };
    }
    if (hasSig) {
      try {
        const sigContent = fs.readFileSync(sigPath, "utf8");
        const sigData = BundleSignatureDataSchema.parse(JSON.parse(sigContent));

        if (entry.signatureIdentity?.keyId && sigData.keyId !== entry.signatureIdentity.keyId) {
          return {
            verified: false,
            error: `Signature keyId mismatch: expected '${entry.signatureIdentity.keyId}', got '${sigData.keyId}'`,
          };
        }

        const loader = this.getLoader();
        const keyStore = this.keyStore ?? loader.keyStore;
        if (keyStore) {
          const unsignedFiles = filesToArchive.filter(
            (file) => file.path !== BUNDLE_FILE_SIGNATURE,
          );
          const { archive: unsignedArchive, fileDigests } = encodeDeterministicTar(unsignedFiles);
          const sigResult = await verifyBundleSignature(sigData, keyStore, {
            allowDevKeys: this.allowDevKeys,
            expectedBundleDigest: createHash("sha256").update(unsignedArchive).digest("hex"),
            expectedFileDigests: fileDigests,
          });
          if (!sigResult.valid) {
            return {
              verified: false,
              error: `Signature verification failed: ${sigResult.error ?? sigResult.reason}`,
            };
          }
        }
      } catch (err) {
        return { verified: false, error: `Signed bundle inspection failed: ${err}` };
      }
    }
    if (!verifyArchiveDigest) return { verified: true };

    // 4. Reconstruct deterministic tar archive and verify against entry.artifactDigest
    try {
      const normEntryDigest = normalizeSha256(entry.artifactDigest, false);
      const { archive } = encodeDeterministicTar(filesToArchive);
      const recomputedDigest = createHash("sha256").update(archive).digest("hex");
      if (recomputedDigest !== normEntryDigest) {
        return {
          verified: false,
          error: `Archive rehash digest '${recomputedDigest}' does not match locked artifactDigest '${normEntryDigest}'`,
        };
      }
    } catch (err) {
      return {
        verified: false,
        error: `Failed to reconstruct deterministic tar archive: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { verified: true };
  }

  async execute(params: LocalArtifactExecuteParams): Promise<CallToolResult> {
    const { entry, parameters, context } = params;
    this.managedToolAccess?.assertAllowed(entry);
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

    // 1. Artifact bytes, never unsigned catalog metadata, govern execution.
    let manifest = this.cache.getArtifactManifest(entry.artifactDigest) ?? undefined;
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

    let catalogDigestMatches = false;
    if (params.manifest) {
      const catalogManifest = ToolManifestSchema.safeParse(params.manifest);
      // Catalog delivery may add provenance metadata or normalize its digest, but
      // it cannot redefine the signed tool's identity, inputs, grants, or limits.
      const executionFields = [
        "id",
        "name",
        "version",
        "parameters",
        "runtime",
        "capabilities",
        "limits",
      ] as const;
      if (
        !catalogManifest.success ||
        executionFields.some(
          (field) => canonicalJson(catalogManifest.data[field]) !== canonicalJson(manifest[field]),
        )
      ) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Catalog execution manifest does not match the artifact manifest",
            },
          ],
        };
      }
      catalogDigestMatches = Boolean(
        entry.manifestDigest && matchesManifestDigest(catalogManifest.data, entry.manifestDigest),
      );
    }

    // 2. A catalog digest may cover different delivery metadata, but only after
    // its execution fields match the artifact. Signature verification below still
    // authenticates all artifact bytes; catalog metadata never replaces those bytes.
    let artifactVerified = false;
    if (
      entry.manifestDigest &&
      !catalogDigestMatches &&
      !matchesManifestDigest(manifest, entry.manifestDigest)
    ) {
      const rehashResult = await this.verifyArtifactDirectory(artifactDir, entry, manifest);
      if (!rehashResult.verified) {
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
      artifactVerified = true;
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

    // 5. Bind every signed file and the unsigned archive digest to the trusted signature.
    // A pin requires signatures even for catalog entries without signatureIdentity.
    if (
      !artifactVerified &&
      (this.requireSignature ||
        entry.signatureIdentity?.keyId ||
        fs.existsSync(path.join(artifactDir, BUNDLE_FILE_SIGNATURE)))
    ) {
      const verification = await this.verifyArtifactDirectory(artifactDir, entry, manifest, false);
      if (!verification.verified) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Bundle signature verification failed: ${verification.error}`,
            },
          ],
        };
      }
    }

    // A recorded-workflow artifact is a compiled plan, not a Deno module: the verified
    // entrypoint bytes are the frozen RecordedWorkflow, executed host-side through the
    // same routing the original calls used. The worker sandbox cannot dispatch tool
    // calls, so the plan runs here under the executor's own permissions.
    if (manifest.runtime?.runtime === "recorded-workflow") {
      return await this.executeRecordedWorkflowArtifact(
        entrypointPath,
        parameters,
        context,
        params.signal,
        params.timeoutMs,
      );
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

    const commandFailures = new CommandFailureDiagnostics(workspaceRoot);
    const brokerHandler = commandFailures.wrap(
      brokerManager.createRequestHandler({
        invocationId,
        grant,
        workspaceRoot,
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        toolId: manifest.id,
        toolVersion: manifest.version,
      }),
    );

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

    // 8. Determine timeout and resource limits from manifest. The manifest limit
    // is authoritative for how long the tool may run; a caller deadline can only
    // shorten it, never silently replace it.
    const manifestTimeoutMs = manifest.limits?.timeoutMs ?? manifest.runtime?.timeoutMs ?? 30000;
    const timeoutMs =
      params.timeoutMs !== undefined
        ? Math.min(params.timeoutMs, manifestTimeoutMs)
        : manifestTimeoutMs;

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
      this.managedToolAccess?.assertAllowed(entry);
      const result = await worker.execute(invocationId, parameters, {
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        toolId: manifest.id,
        version: manifest.version,
      });

      if (result.status === "success") {
        const text =
          typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
        const failed = commandFailures.isReportedFailure(result.output);
        const response: CallToolResult = {
          ...(failed ? { isError: true } : {}),
          content: [{ type: "text", text }],
        };
        return failed ? commandFailures.append(response, maxOutputSizeBytes) : response;
      }

      if (params.signal?.aborted) {
        return commandFailures.append(
          {
            isError: true,
            content: [
              {
                type: "text",
                text: `Tool invocation was aborted by the caller before it completed (${result.error?.message ?? result.status}); the tool's manifest allows ${manifestTimeoutMs}ms.`,
              },
            ],
          },
          maxOutputSizeBytes,
        );
      }

      return commandFailures.append(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: result.error?.message ?? `Tool execution failed with status: ${result.status}`,
            },
          ],
        },
        maxOutputSizeBytes,
      );
    } catch (err) {
      return commandFailures.append(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        },
        maxOutputSizeBytes,
      );
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      brokerManager.cleanupInvocation(invocationId);
    }
  }

  /**
   * Executes a verified recorded-workflow artifact. The plan is the frozen
   * RecordedWorkflow the compiler produced; each step dispatches through `stepInvoker`
   * (the same routing the original call used) and private references resolve from the
   * local value store. A plan that needs an adapter or a value this host does not have
   * fails with the actual reason rather than a substituted behavior.
   */
  private async executeRecordedWorkflowArtifact(
    entrypointPath: string,
    parameters: JsonRpcParams,
    context: WorkspaceContext,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    const fail = (text: string): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text }],
    });
    if (!this.stepInvoker) {
      return fail(
        "This recorded-workflow tool needs a step dispatcher, which this executor was not given",
      );
    }
    let plan: RecordedWorkflow;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(entrypointPath, "utf8"));
      const validation = validateRecordedWorkflow(parsed);
      if (!validation.valid) {
        return fail(
          `Recorded workflow artifact is not a valid plan: ${validation.errors.join("; ")}`,
        );
      }
      plan = parsed as RecordedWorkflow;
    } catch (err) {
      return fail(
        `Failed to read recorded workflow artifact: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const adapters = new RuntimeAdapterRegistry();
    const stepInvoker = this.stepInvoker;
    adapters.register({
      runtime: RESIN_INVOKE_TOOL_RUNTIME,
      call: async (request) => {
        const result = await stepInvoker({
          name: request.step.callable.name,
          ...(request.step.callable.connection
            ? { connection: request.step.callable.connection }
            : {}),
          parameters: request.arguments as Record<string, unknown>,
          context,
          ...(signal ? { signal } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (result.isError) {
          const text = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;
          throw new Error(text ?? `step '${request.step.id}' failed`);
        }
        return composedResultValue(result);
      },
    });

    const store = this.privateValueStore ?? FilePrivateValueStore.default();
    const artifact: CompiledWorkflowArtifact = {
      plan,
      digest: "",
      name: plan.workflowId,
      inputSchema: {},
      outputContract: { fromStep: plan.steps[plan.steps.length - 1]?.id ?? "", callable: "" },
      requiredRuntimes: [...new Set(plan.steps.map((step) => step.callable.runtime))],
      requiredPrivateReferences: [...(plan.privateReferences ?? [])],
      permissions: [],
    };
    const callable = instantiateRecordedWorkflow(artifact, {
      adapters,
      resolvePrivate: (reference) => resolvePrivateReference(store, reference) as WorkflowJsonValue,
    });
    try {
      const execution = await callable.invoke(parameters as Record<string, WorkflowJsonValue>);
      if (execution.status !== "completed") {
        return fail(execution.error ?? "Recorded workflow execution failed");
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(execution.result ?? null),
          },
        ],
      };
    } catch (err) {
      return fail(
        `Recorded workflow execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
