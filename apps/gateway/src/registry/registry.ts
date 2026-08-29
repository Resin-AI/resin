import fs from "node:fs";
import path from "node:path";
import {
  type CapabilityEnvelope,
  type CatalogSnapshot,
  type CatalogToolSummary,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  type ToolVersionStatus,
  type V1LockedToolEntry,
  type V1ToolLock,
  canonicalJson,
  normalizeSha256,
  validateV1ToolLock,
} from "@resin/contracts";
import { LocalDatabaseConnection, ToolRepository } from "@resin/db";
import { resolvePaths } from "@resin/observer";
import {
  ArtifactCache,
  DeterministicWorkerSandbox,
  type SafetyGateEvaluator,
} from "@resin/runtime";
import {
  type ToolInvocationRouter,
  createSystemMetaTools,
  isSystemMetaTool,
} from "../meta/index.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { CatalogCache } from "./cache.js";
import { UserControlsManager, type UserControlsManagerOptions } from "./controls.js";
import { CatalogChangeEventEmitter } from "./events.js";
import { type CandidateToolForNaming, resolveNameCollision, sanitizeToolName } from "./naming.js";
import { buildCatalogSnapshot } from "./snapshot.js";
import type {
  CatalogEntry,
  CatalogSnapshotRecord,
  RegistryTool,
  ToolRegistryOptions,
  ToolScopeHierarchy,
  ValidationResult,
} from "./types.js";
import { computeManifestDigest, computeSha256, validateToolStaging } from "./validator.js";

export function digestsMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  try {
    return normalizeSha256(a, false) === normalizeSha256(b, false);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

export function validateLockedToolTuple(
  tool: RegistryTool,
  lockedEntry: V1LockedToolEntry,
): { valid: boolean; reason?: string } {
  if (tool.toolId !== lockedEntry.toolId) {
    return {
      valid: false,
      reason: `Tool ID mismatch: registered '${tool.toolId}' vs locked '${lockedEntry.toolId}'`,
    };
  }

  const toolName = tool.name || tool.manifest?.name;
  if (toolName !== lockedEntry.name) {
    return {
      valid: false,
      reason: `Tool name mismatch: registered '${toolName}' vs locked '${lockedEntry.name}'`,
    };
  }

  const toolVersion = tool.version || tool.manifest?.version;
  if (toolVersion !== lockedEntry.version) {
    return {
      valid: false,
      reason: `Tool version mismatch: registered '${toolVersion}' vs locked '${lockedEntry.version}'`,
    };
  }

  if (
    lockedEntry.status === "disabled" ||
    (lockedEntry.status as string) === "revoked" ||
    (lockedEntry.status as string) === "blocked"
  ) {
    return {
      valid: false,
      reason: `Locked tool '${lockedEntry.name}' has non-active status '${lockedEntry.status}'`,
    };
  }

  if (
    tool.status === "deprecated" ||
    tool.status === "revoked" ||
    tool.status === "disabled" ||
    tool.status === "blocked"
  ) {
    return {
      valid: false,
      reason: `Registered tool '${tool.name}' has non-active status '${tool.status}'`,
    };
  }

  const toolManifestDigest =
    tool.manifestDigest || (tool.manifest ? computeManifestDigest(tool.manifest) : undefined);
  if (lockedEntry.manifestDigest) {
    if (!toolManifestDigest) {
      return {
        valid: false,
        reason: `Missing manifest digest for tool '${tool.name}'`,
      };
    }
    if (!digestsMatch(toolManifestDigest, lockedEntry.manifestDigest)) {
      return {
        valid: false,
        reason: `Manifest digest mismatch for tool '${tool.name}': registered '${toolManifestDigest}' vs locked '${lockedEntry.manifestDigest}'`,
      };
    }
  }

  const toolArtifactDigest = tool.artifactDigest || tool.artifact?.artifactDigest;
  if (lockedEntry.artifactDigest) {
    if (!toolArtifactDigest) {
      return {
        valid: false,
        reason: `Missing artifact digest for tool '${tool.name}'`,
      };
    }
    if (!digestsMatch(toolArtifactDigest, lockedEntry.artifactDigest)) {
      return {
        valid: false,
        reason: `Artifact digest mismatch for tool '${tool.name}': registered '${toolArtifactDigest}' vs locked '${lockedEntry.artifactDigest}'`,
      };
    }
  }

  if (lockedEntry.envelopeDigest) {
    let toolEnvelopeDigest = tool.envelopeDigest;
    if (!toolEnvelopeDigest && tool.envelope) {
      try {
        toolEnvelopeDigest = computeSha256(canonicalJson(tool.envelope));
      } catch {
        // Ignore
      }
    }
    if (toolEnvelopeDigest && !digestsMatch(toolEnvelopeDigest, lockedEntry.envelopeDigest)) {
      return {
        valid: false,
        reason: `Envelope digest mismatch for tool '${tool.name}': registered '${toolEnvelopeDigest}' vs locked '${lockedEntry.envelopeDigest}'`,
      };
    }
  }

  return { valid: true };
}

export interface ExecutionHandlerOptions {
  timeoutMs?: number;
}

export interface ToolRepoLike {
  saveManifest?(manifest: ToolManifest): Promise<void>;
  getManifest?(toolId: string, version?: string): Promise<ToolManifest | null>;
  listManifests?(options?: { scope?: string }): Promise<ToolManifest[]>;
  saveToolVersion?(version: ToolVersion): Promise<void>;
  getToolVersion?(toolId: string, version: string): Promise<ToolVersion | null>;
  listToolVersions?(toolId?: string): Promise<ToolVersion[]>;
  saveCatalogSnapshot?(snapshot: CatalogSnapshot): Promise<void>;
  getCatalogSnapshot?(snapshotId: string): Promise<CatalogSnapshot | null>;
  listCatalogSnapshots?(workspaceId?: string): Promise<CatalogSnapshot[]>;
  getLatestCatalogSnapshot?(workspaceId: string): Promise<CatalogSnapshot | null>;
  listDeployments?(options?: { workspaceId?: string; toolId?: string; state?: string }): Promise<
    unknown[]
  >;
  listInstallations?(workspaceId?: string): Promise<unknown[]>;
}

interface StateStoreLike {
  getToolRepository?(): ToolRepoLike;
  tools?: ToolRepoLike;
}

/**
 * Creates a tool execution handler for an evolved tool version.
 */
export function createEvolvedToolHandler(
  toolVersion:
    | ToolVersion
    | { manifest: ToolManifest; artifact?: ToolArtifact; status?: string; sourceCode?: string },
): ToolHandler {
  return async (
    context: WorkspaceContext,
    params: Record<string, unknown>,
    options?: ToolCallOptions,
  ) => {
    const manifest = toolVersion.manifest;
    const artifact = "artifact" in toolVersion ? toolVersion.artifact : undefined;
    let sourceCode: string | undefined;
    if (
      "sourceCode" in toolVersion &&
      typeof toolVersion.sourceCode === "string" &&
      toolVersion.sourceCode.trim().length > 0
    ) {
      sourceCode = toolVersion.sourceCode;
    } else if (
      artifact?.sourceCode &&
      typeof artifact.sourceCode === "string" &&
      artifact.sourceCode.trim().length > 0
    ) {
      sourceCode = artifact.sourceCode;
    }

    let bundlePathOrSource: string | undefined = sourceCode;
    if (!bundlePathOrSource && artifact?.bundleReference?.uri) {
      const uri = artifact.bundleReference.uri;
      if (uri.startsWith("file://")) {
        const filePath = uri.replace("file://", "");
        if (fs.existsSync(filePath)) {
          bundlePathOrSource = filePath;
        }
      }
    }

    let effectiveArtifactDigest = artifact?.artifactDigest;
    if (
      !effectiveArtifactDigest &&
      "artifactDigest" in toolVersion &&
      typeof toolVersion.artifactDigest === "string"
    ) {
      effectiveArtifactDigest = toolVersion.artifactDigest;
    }
    if (!bundlePathOrSource && effectiveArtifactDigest) {
      try {
        const cache = new ArtifactCache();
        const cachedPath = cache.getArtifactPath(effectiveArtifactDigest);
        if (fs.existsSync(cachedPath)) {
          bundlePathOrSource = cachedPath;
        }
      } catch {
        // Ignore cache lookup failure
      }
    }

    if (bundlePathOrSource) {
      try {
        const timeoutMs = options?.timeoutMs ?? manifest.limits?.timeoutMs ?? 30000;
        const result = await DeterministicWorkerSandbox.execute(
          manifest,
          bundlePathOrSource,
          params,
          {
            workspaceRoot: context.canonicalRoot,
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            timeoutMs,
          },
        );
        if (result.status === "success") {
          const textOutput =
            typeof result.output === "string" ? result.output : JSON.stringify(result.output);
          return {
            content: [
              {
                type: "text",
                text: textOutput,
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: result.error?.message || `Tool execution failed with status: ${result.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: (err as Error).message || "Tool execution error",
            },
          ],
        };
      }
    }

    // Default fallback execution matching e2e fixture behavior
    // Fail closed without simulated execution when executable artifact or source code is absent
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool '${manifest.name}' (${manifest.id}@${manifest.version}) executable artifact or source code is unavailable. Execution failed closed without simulated fallback.`,
        },
      ],
    };
  };
}

export const createExecutionHandler = createEvolvedToolHandler;

export function extractToolRepo(db: unknown): ToolRepoLike | null {
  if (!db) {
    try {
      const paths = resolvePaths();
      const dbPath = path.join(paths.dataDir, "state.db");
      if (fs.existsSync(dbPath)) {
        const conn = new LocalDatabaseConnection({ path: dbPath });
        return new ToolRepository(conn);
      }
    } catch {
      // Ignore
    }
    return null;
  }
  if (typeof db !== "object") {
    return null;
  }
  if (db instanceof ToolRepository) {
    return db;
  }
  if (
    db instanceof LocalDatabaseConnection ||
    ("run" in db && "get" in db && "all" in db && typeof db.run === "function")
  ) {
    return new ToolRepository(db as LocalDatabaseConnection);
  }
  const store = db as StateStoreLike;
  if (typeof store.getToolRepository === "function") {
    return store.getToolRepository() ?? null;
  }
  if (store.tools && typeof store.tools.saveToolVersion === "function") {
    return store.tools;
  }
  if ("saveManifest" in db && typeof (db as ToolRepoLike).saveManifest === "function") {
    return db as ToolRepoLike;
  }
  return null;
}
/**
 * Dynamic Tool Registry managing workspace-scoped tool visibility, pre-staging validation,
 * atomic version activation, rollback, user controls, and catalog snapshot caching.
 */
export class ToolRegistry {
  private readonly toolRepo: ToolRepoLike | null;
  private readonly defaultEnvelope?: CapabilityEnvelope;
  readonly cache: CatalogCache;
  readonly controls: UserControlsManager;
  readonly events: CatalogChangeEventEmitter;

  // toolId -> version -> RegistryTool
  private readonly registeredTools = new Map<string, Map<string, RegistryTool>>();
  // toolId -> latest registered version string
  private readonly latestVersions = new Map<string, string>();
  private invocationRouter?: ToolInvocationRouter;
  private safetyGateEvaluator?: SafetyGateEvaluator;
  // Scope activations: scopeKey -> Map<toolId, version>
  // System scope
  private readonly systemActiveTools = new Map<string, string>();
  // Account scope: accountId -> (toolId -> version)
  private readonly accountActiveTools = new Map<string, Map<string, string>>();
  // Workspace scope: workspaceId -> (toolId -> version)
  private readonly workspaceActiveTools = new Map<string, Map<string, string>>();
  // Session scope: sessionId -> (toolId -> version)
  private readonly sessionActiveTools = new Map<string, Map<string, string>>();
  // Workspace-bound V1ToolLocks: workspaceId -> V1ToolLock
  private readonly workspaceLocks = new Map<string, V1ToolLock>();

  // Monotonic local revision counter per workspace
  private readonly workspaceRevisions = new Map<string, number>();
  // Snapshot history per workspace
  private readonly snapshotHistory = new Map<string, CatalogSnapshotRecord[]>();
  private hydrated = false;
  private hydrationPromise?: Promise<number>;

  constructor(options?: ToolRegistryOptions | unknown) {
    const db =
      options && typeof options === "object" && "db" in options
        ? (options as ToolRegistryOptions).db
        : options;
    const opts = (
      options &&
      typeof options === "object" &&
      !("run" in options) &&
      !("getConnection" in options) &&
      !("saveManifest" in options) &&
      !("tools" in options)
        ? options
        : undefined
    ) as ToolRegistryOptions | undefined;

    this.toolRepo = extractToolRepo(db);
    this.defaultEnvelope = opts?.defaultEnvelope;
    this.cache = new CatalogCache({ maxSize: opts?.cacheSize });
    const userControlsOpts = opts as UserControlsManagerOptions | undefined;
    const lockMgrOpt = userControlsOpts?.lockManager;
    const lockMgrsOpt = userControlsOpts?.lockManagers;

    this.controls = new UserControlsManager(db, {
      lockManager: lockMgrOpt,
      lockManagers: lockMgrsOpt,
      onChange: (workspaceId: string) => {
        this.cache.invalidateWorkspace(workspaceId);
      },
    });
    this.events = new CatalogChangeEventEmitter({ debounceMs: opts?.debounceMs });
    this.invocationRouter = opts?.invocationRouter;
    this.safetyGateEvaluator = opts?.safetyGateEvaluator;
    this.initSystemMetaTools();
    if (opts?.initialTools) {
      for (const tool of opts.initialTools) {
        this.registerToolSync(tool);
      }
    }
    if (opts?.autoHydrate !== false && this.toolRepo) {
      void this.hydrateFromStore();
    }
  }

  /**
   * Updates the invocation router for system meta-tools.
   */
  setInvocationRouter(router: ToolInvocationRouter): void {
    this.invocationRouter = router;
    this.initSystemMetaTools();
  }

  /**
   * Sets or updates the safety gate evaluator.
   */
  setSafetyGateEvaluator(evaluator: SafetyGateEvaluator): void {
    this.safetyGateEvaluator = evaluator;
    this.initSystemMetaTools();
  }

  getSafetyGateEvaluator(): SafetyGateEvaluator | undefined {
    return this.safetyGateEvaluator;
  }

  private initSystemMetaTools(): void {
    const metaTools = createSystemMetaTools(this, this.invocationRouter, this.safetyGateEvaluator);
    for (const tool of metaTools) {
      this.registerToolSync(tool);
    }
  }

  /**
   * Returns all registered tools across all versions.
   */
  getAllRegisteredTools(): RegistryTool[] {
    const list: RegistryTool[] = [];
    for (const versionMap of this.registeredTools.values()) {
      for (const tool of versionMap.values()) {
        list.push(tool);
      }
    }
    return list;
  }

  /**
   * Returns the latest registered version string for a toolId.
   */
  getLatestRegisteredVersion(toolId: string): string | undefined {
    const direct = this.latestVersions.get(toolId);
    if (direct) return direct;
    for (const [id, vMap] of this.registeredTools.entries()) {
      for (const t of vMap.values()) {
        if (t.name === toolId || t.exposedName === toolId || t.manifest?.name === toolId) {
          return this.latestVersions.get(id);
        }
      }
    }
    return undefined;
  }

  /**
   * Binds a validated V1ToolLock to a workspace.
   * Invalidates cached snapshots for the workspace.
   */
  bindWorkspaceLock(workspaceId: string, lock: unknown): V1ToolLock {
    const validatedLock = validateV1ToolLock(lock);
    this.workspaceLocks.set(workspaceId, validatedLock);
    this.cache.invalidateWorkspace(workspaceId);
    return validatedLock;
  }

  /**
   * Alias for bindWorkspaceLock.
   */
  bindLock(workspaceId: string, lock: unknown): V1ToolLock {
    return this.bindWorkspaceLock(workspaceId, lock);
  }

  /**
   * Alias for bindWorkspaceLock.
   */
  bindProjectLock(workspaceId: string, lock: unknown): V1ToolLock {
    return this.bindWorkspaceLock(workspaceId, lock);
  }

  /**
   * Unbinds the V1ToolLock from a workspace.
   */
  unbindWorkspaceLock(workspaceId: string): void {
    this.workspaceLocks.delete(workspaceId);
    this.cache.invalidateWorkspace(workspaceId);
  }

  /**
   * Alias for unbindWorkspaceLock.
   */
  unbindLock(workspaceId: string): void {
    this.unbindWorkspaceLock(workspaceId);
  }

  /**
   * Gets the bound V1ToolLock for a workspace, if any.
   */
  getWorkspaceLock(workspaceId: string): V1ToolLock | undefined {
    return this.workspaceLocks.get(workspaceId);
  }

  /**
   * Alias for getWorkspaceLock.
   */
  getBoundLock(workspaceId: string): V1ToolLock | undefined {
    return this.getWorkspaceLock(workspaceId);
  }

  /**
   * Returns true if workspace has a bound V1ToolLock.
   */
  hasWorkspaceLock(workspaceId: string): boolean {
    return this.workspaceLocks.has(workspaceId);
  }

  /**
   * Validates a tool against a locked entry tuple.
   */
  validateLockedToolTuple(
    tool: RegistryTool,
    lockedEntry: V1LockedToolEntry,
  ): { valid: boolean; reason?: string } {
    return validateLockedToolTuple(tool, lockedEntry);
  }
  /**
   * Pre-stages and validates a tool manifest and artifact against capability envelopes.
   */
  async stageToolVersion(
    manifest: unknown,
    artifact?: unknown,
    envelope?: CapabilityEnvelope,
  ): Promise<ValidationResult> {
    const targetEnvelope = envelope ?? this.defaultEnvelope;
    const existingVersions = this.getExistingVersionsForManifest(manifest);

    const result = validateToolStaging(manifest, artifact, targetEnvelope, {
      existingVersions,
    });

    if (!result.valid) {
      return result;
    }

    const validatedManifest = ToolManifestSchema.parse(manifest);
    const toolId = validatedManifest.id;
    let validatedArtifact: ToolArtifact | undefined;
    if (artifact !== undefined) {
      if (
        typeof artifact === "object" &&
        artifact !== null &&
        "artifactDigest" in artifact &&
        "bundleReference" in artifact
      ) {
        validatedArtifact = ToolArtifactSchema.parse(artifact);
      } else {
        const rawArt = artifact as Record<string, unknown>;
        const code =
          typeof rawArt.code === "string"
            ? rawArt.code
            : typeof rawArt.sourceCode === "string"
              ? rawArt.sourceCode
              : "";
        const digest =
          typeof rawArt.digest === "string"
            ? rawArt.digest
            : typeof rawArt.artifactDigest === "string"
              ? rawArt.artifactDigest
              : computeSha256(code || `${toolId}@${validatedManifest.version}`);
        validatedArtifact = ToolArtifactSchema.parse({
          artifactDigest: digest,
          bundleReference: {
            uri: `memory://${toolId}/${validatedManifest.version}`,
            hash: digest,
            sizeBytes: Buffer.byteLength(code, "utf8"),
            format: "embedded",
          },
          entrypoint: typeof rawArt.entrypoint === "string" ? rawArt.entrypoint : "index.js",
          sourceCode: code,
          checksums: {},
        });
      }
    }

    // Register into memory
    const registryTool: RegistryTool = {
      toolId,
      name: validatedManifest.name,
      version: validatedManifest.version,
      manifest: validatedManifest,
      manifestDigest: result.manifestDigest,
      artifact: validatedArtifact,
      artifactDigest: result.artifactDigest,
      envelope: targetEnvelope,
      envelopeDigest: targetEnvelope ? computeSha256(canonicalJson(targetEnvelope)) : undefined,
      scope: validatedManifest.scope as ToolScopeHierarchy,
      status: "active",
      description: validatedManifest.description,
      parameters: validatedManifest.parameters,
      outputSchema: validatedManifest.outputSchema,
      metadata: validatedManifest.metadata,
      createdAt: validatedManifest.createdAt,
      updatedAt: validatedManifest.updatedAt,
      sourceCode: validatedArtifact?.sourceCode,
    };

    this.registerToolSync(registryTool);

    // Persist to DB if repository available
    if (this.toolRepo) {
      try {
        if (this.toolRepo.saveManifest) {
          await this.toolRepo.saveManifest(validatedManifest);
        }
        if (this.toolRepo.saveToolVersion && validatedArtifact) {
          const toolVersion: ToolVersion = {
            toolId,
            version: validatedManifest.version,
            manifestDigest: result.manifestDigest || validatedManifest.digest,
            artifactDigest: result.artifactDigest || validatedArtifact.artifactDigest,
            manifest: validatedManifest,
            artifact: validatedArtifact,
            provenance: {
              synthesizedAt: new Date().toISOString(),
              synthesizerModel: "gateway",
              deterministicBuildHash: result.artifactDigest || validatedArtifact.artifactDigest,
              environment: {},
            },
            status: "active",
            createdAt: validatedManifest.createdAt,
            createdBy: "gateway",
          };
          ToolVersionSchema.parse(toolVersion);
          await this.toolRepo.saveToolVersion(toolVersion);
        }
      } catch {
        // Suppress DB persistence failure during staging if running in ephemeral mode
      }
    }
    return result;
  }

  private getExistingVersionsForManifest(rawManifest: unknown): ToolVersion[] {
    if (!rawManifest || typeof rawManifest !== "object") {
      return [];
    }
    const raw = rawManifest as { id?: string; toolId?: string };
    const toolId = raw.id ?? raw.toolId;
    if (!toolId) {
      return [];
    }
    const versions = this.registeredTools.get(toolId);
    if (!versions) {
      return [];
    }

    const list: ToolVersion[] = [];
    for (const tool of versions.values()) {
      if (tool.artifact) {
        list.push({
          toolId: tool.toolId,
          version: tool.version,
          manifestDigest: tool.manifest.digest,
          artifactDigest: tool.artifact.artifactDigest,
          manifest: tool.manifest,
          artifact: tool.artifact,
          provenance: {
            synthesizedAt: tool.createdAt || new Date().toISOString(),
            synthesizerModel: "memory",
            deterministicBuildHash: tool.artifact.artifactDigest,
            environment: {},
          },
          status: (tool.status === "disabled"
            ? "deprecated"
            : (tool.status ?? "active")) as ToolVersionStatus,
          createdAt: tool.createdAt || new Date().toISOString(),
          createdBy: "gateway",
        });
      }
    }
    return list;
  }

  /**
   * Registers a tool directly into the in-memory registry.
   */
  registerToolSync(tool: RegistryTool): void {
    let versions = this.registeredTools.get(tool.toolId);
    if (!versions) {
      versions = new Map();
      this.registeredTools.set(tool.toolId, versions);
    }
    if (!tool.manifestDigest && tool.manifest) {
      try {
        tool.manifestDigest = computeManifestDigest(tool.manifest);
      } catch {
        // Ignore
      }
    }
    if (!tool.artifactDigest && tool.artifact?.artifactDigest) {
      tool.artifactDigest = tool.artifact.artifactDigest;
    }
    if (!tool.envelopeDigest && tool.envelope) {
      try {
        tool.envelopeDigest = computeSha256(canonicalJson(tool.envelope));
      } catch {
        // Ignore
      }
    }
    if (!tool.handler) {
      tool.handler = createExecutionHandler(tool);
    }
    versions.set(tool.version, tool);
    this.latestVersions.set(tool.toolId, tool.version);
    // If tool scope is system/global or isSystem, auto-register in system active list
    if (tool.scope === "system" || tool.scope === "global" || tool.isSystem) {
      this.systemActiveTools.set(tool.toolId, tool.version);
    } else if (tool.workspaceId) {
      let wsTools = this.workspaceActiveTools.get(tool.workspaceId);
      if (!wsTools) {
        wsTools = new Map();
        this.workspaceActiveTools.set(tool.workspaceId, wsTools);
      }
      wsTools.set(tool.toolId, tool.version);
    } else if (tool.sessionId) {
      let sessTools = this.sessionActiveTools.get(tool.sessionId);
      if (!sessTools) {
        sessTools = new Map();
        this.sessionActiveTools.set(tool.sessionId, sessTools);
      }
      sessTools.set(tool.toolId, tool.version);
    }
  }

  /**
   * Registers a tool asynchronously, staging manifest and optional artifact.
   */
  async registerTool(
    tool: RegistryTool | ToolManifest,
    artifact?: ToolArtifact,
    options?: {
      scope?: ToolScopeHierarchy;
      workspaceId?: string;
      sessionId?: string;
      manifestDigest?: string;
      artifactDigest?: string;
      envelope?: CapabilityEnvelope;
      envelopeDigest?: string;
    },
  ): Promise<RegistryTool> {
    if ("toolId" in tool && "manifest" in tool) {
      const regTool = tool as RegistryTool;
      if (options?.manifestDigest && !regTool.manifestDigest)
        regTool.manifestDigest = options.manifestDigest;
      if (options?.artifactDigest && !regTool.artifactDigest)
        regTool.artifactDigest = options.artifactDigest;
      if (options?.envelope && !regTool.envelope) regTool.envelope = options.envelope;
      if (options?.envelopeDigest && !regTool.envelopeDigest)
        regTool.envelopeDigest = options.envelopeDigest;
      this.registerToolSync(regTool);
      return regTool;
    }

    const manifest = tool as ToolManifest;
    await this.stageToolVersion(manifest, artifact, options?.envelope);

    const registered = this.registeredTools.get(manifest.id)?.get(manifest.version);
    if (!registered) {
      throw new Error(`Failed to stage tool ${manifest.id} version ${manifest.version}`);
    }

    if (options?.manifestDigest && !registered.manifestDigest)
      registered.manifestDigest = options.manifestDigest;
    if (options?.artifactDigest && !registered.artifactDigest)
      registered.artifactDigest = options.artifactDigest;
    if (options?.envelope && !registered.envelope) registered.envelope = options.envelope;
    if (options?.envelopeDigest && !registered.envelopeDigest)
      registered.envelopeDigest = options.envelopeDigest;

    if (options?.workspaceId) {
      registered.workspaceId = options.workspaceId;
      if (options.sessionId) registered.sessionId = options.sessionId;
      if (options.scope) registered.scope = options.scope;
      await this.activateToolVersion(manifest.id, manifest.version, options.workspaceId, {
        sessionId: options.sessionId,
        scope: options.scope,
      });
    }

    return registered;
  }

  /**
   * Resolves the visible tool catalog for a workspace and optional session,
   * applying scope hierarchy, user pins/disables, name collision resolution,
   * and LRU snapshot caching.
   */
  async resolveCatalog(workspaceId: string, sessionId?: string): Promise<CatalogSnapshot> {
    // 1. Check LRU Cache
    const cached = this.cache.get(workspaceId, sessionId);
    if (cached) {
      return cached;
    }
    if (this.toolRepo && (!this.hydrated || this.hydrationPromise)) {
      await this.hydrateFromStore({ workspaceId });
    }

    // 2. Load User Controls
    const controls = await this.controls.getControls(workspaceId);

    // 3. Resolve tools across Scope Hierarchy (Session > Workspace > Account > System)
    interface CandidateEntry {
      tool: RegistryTool;
      scope: ToolScopeHierarchy;
      priority: number;
    }

    const candidateTools = new Map<string, CandidateEntry>();

    const boundLock = this.workspaceLocks.get(workspaceId);

    if (boundLock) {
      // Invariant: Keep built-in system meta-tools working
      for (const [toolId, version] of this.systemActiveTools.entries()) {
        if (controls.disabledTools.includes(toolId) && !isSystemMetaTool(toolId)) {
          continue;
        }
        const tool = this.registeredTools.get(toolId)?.get(version);
        if (tool) {
          candidateTools.set(toolId, { tool, scope: "system", priority: 1 });
        }
      }

      // Exact locked entries ONLY (no latest-version fallback, no unbound workspace tools)
      for (const [entryKey, lockedEntry] of Object.entries(boundLock.tools)) {
        if (entryKey !== lockedEntry.name) {
          continue; // Malformed lock entry key mismatch
        }

        // Revoked/disabled/blocked statuses never resolve
        if (
          lockedEntry.status === "disabled" ||
          (lockedEntry.status as string) === "revoked" ||
          (lockedEntry.status as string) === "blocked"
        ) {
          continue;
        }

        if (
          controls.disabledTools.includes(lockedEntry.toolId) ||
          controls.disabledTools.includes(lockedEntry.name)
        ) {
          continue;
        }

        // Look up EXACT registered tool version
        let tool = this.registeredTools.get(lockedEntry.toolId)?.get(lockedEntry.version);
        if (!tool) {
          for (const versions of this.registeredTools.values()) {
            const candidate = versions.get(lockedEntry.version);
            if (
              candidate &&
              (candidate.name === lockedEntry.name || candidate.manifest?.name === lockedEntry.name)
            ) {
              tool = candidate;
              break;
            }
          }
        }

        if (!tool) {
          // Missing exact version fails closed without crashing other tools
          continue;
        }

        // Validate tuple: toolId, name, version, manifestDigest, artifactDigest, envelopeDigest
        const validation = validateLockedToolTuple(tool, lockedEntry);
        if (!validation.valid) {
          // Mismatched tuple fails closed without crashing other tools
          continue;
        }

        candidateTools.set(lockedEntry.toolId, {
          tool,
          scope: "workspace",
          priority: 2,
        });
      }
    } else {
      // Layer 1: System Scope (Priority 1)
      for (const [toolId, version] of this.systemActiveTools.entries()) {
        const targetVersion = controls.pinnedVersions[toolId] ?? version;
        let tool = this.registeredTools.get(toolId)?.get(targetVersion);
        if (!tool) {
          for (const versions of this.registeredTools.values()) {
            const candidate = versions.get(targetVersion);
            if (
              candidate &&
              (candidate.name === toolId ||
                candidate.exposedName === toolId ||
                candidate.manifest?.name === toolId)
            ) {
              tool = candidate;
              break;
            }
          }
        }
        if (tool) {
          if (
            !isSystemMetaTool(toolId) &&
            !tool.isSystem &&
            (controls.disabledTools.includes(toolId) ||
              controls.disabledTools.includes(tool.toolId) ||
              controls.disabledTools.includes(tool.name))
          ) {
            continue;
          }
          candidateTools.set(tool.toolId, { tool, scope: "system", priority: 1 });
        }
      }

      // Layer 2: Workspace Scope (Priority 2)
      const wsMap = this.workspaceActiveTools.get(workspaceId);
      if (wsMap) {
        for (const [toolId, version] of wsMap.entries()) {
          const targetVersion =
            controls.pinnedVersions[toolId] ??
            Object.entries(controls.pinnedVersions).find(([k]) => k === toolId)?.[1] ??
            version;
          let tool = this.registeredTools.get(toolId)?.get(targetVersion);
          if (!tool) {
            for (const versions of this.registeredTools.values()) {
              const candidate = versions.get(targetVersion);
              if (
                candidate &&
                (candidate.name === toolId ||
                  candidate.exposedName === toolId ||
                  candidate.manifest?.name === toolId ||
                  candidate.toolId === toolId)
              ) {
                tool = candidate;
                break;
              }
            }
          }
          if (tool) {
            if (
              controls.disabledTools.includes(toolId) ||
              controls.disabledTools.includes(tool.toolId) ||
              controls.disabledTools.includes(tool.name) ||
              (tool.exposedName && controls.disabledTools.includes(tool.exposedName))
            ) {
              continue;
            }
            candidateTools.set(tool.toolId, { tool, scope: "workspace", priority: 2 });
          }
        }
      }

      // Also include tools explicitly pinned in user controls even if not yet in wsMap
      for (const [pinnedId, pinnedVer] of Object.entries(controls.pinnedVersions)) {
        if (controls.disabledTools.includes(pinnedId)) {
          continue;
        }
        let tool = this.registeredTools.get(pinnedId)?.get(pinnedVer);
        if (!tool) {
          for (const versions of this.registeredTools.values()) {
            const candidate = versions.get(pinnedVer);
            if (
              candidate &&
              (candidate.name === pinnedId ||
                candidate.exposedName === pinnedId ||
                candidate.manifest?.name === pinnedId ||
                candidate.toolId === pinnedId)
            ) {
              tool = candidate;
              break;
            }
          }
        }
        if (tool) {
          if (
            controls.disabledTools.includes(tool.toolId) ||
            controls.disabledTools.includes(tool.name) ||
            (tool.exposedName && controls.disabledTools.includes(tool.exposedName))
          ) {
            continue;
          }
          candidateTools.set(tool.toolId, { tool, scope: "workspace", priority: 2 });
        }
      }

      // Layer 3: Session Scope (Priority 3)
      if (sessionId) {
        const sessMap = this.sessionActiveTools.get(sessionId);
        if (sessMap) {
          for (const [toolId, version] of sessMap.entries()) {
            if (controls.disabledTools.includes(toolId)) {
              continue;
            }
            const targetVersion = controls.pinnedVersions[toolId] ?? version;
            let tool = this.registeredTools.get(toolId)?.get(targetVersion);
            if (!tool) {
              for (const versions of this.registeredTools.values()) {
                const candidate = versions.get(targetVersion);
                if (
                  candidate &&
                  (candidate.name === toolId ||
                    candidate.exposedName === toolId ||
                    candidate.manifest?.name === toolId)
                ) {
                  tool = candidate;
                  break;
                }
              }
            }
            if (tool) {
              candidateTools.set(tool.toolId, { tool, scope: "session", priority: 3 });
            }
          }
        }
      }
    }
    // 4. Name Collision Resolution
    const namingCandidates: CandidateToolForNaming[] = [];
    for (const { tool, scope } of candidateTools.values()) {
      namingCandidates.push({
        toolId: tool.toolId,
        name: tool.name,
        scope,
        version: tool.version,
        isSystem: tool.isSystem || isSystemMetaTool(tool.toolId) || scope === "system",
      });
    }
    const nameMap = resolveNameCollision(namingCandidates);

    // 5. Build Catalog Entries
    const entries: CatalogEntry[] = [];
    for (const { tool, scope } of candidateTools.values()) {
      const exposedName = nameMap.get(tool.toolId) || sanitizeToolName(tool.name);
      const isPinned =
        Boolean(controls.pinnedVersions[tool.toolId]) ||
        Boolean(controls.pinnedVersions[tool.name]) ||
        (tool.exposedName ? Boolean(controls.pinnedVersions[tool.exposedName]) : false);

      const entry: CatalogEntry = {
        toolId: tool.toolId,
        name: tool.name,
        version: tool.version,
        manifestDigest:
          tool.manifestDigest || tool.manifest.digest || computeManifestDigest(tool.manifest),
        artifactDigest: tool.artifactDigest || tool.artifact?.artifactDigest,
        envelopeDigest: tool.envelopeDigest,
        scope,
        status: tool.status || "active",
        exposedName,
        description: tool.description ?? tool.manifest.description,
        parameters:
          tool.parameters ?? (tool.manifest.parameters as Record<string, unknown> | undefined),
        outputSchema:
          tool.outputSchema ?? (tool.manifest.outputSchema as Record<string, unknown> | undefined),
        manifest: tool.manifest,
        artifact: tool.artifact,
        handler: tool.handler,
        sourceCode: tool.sourceCode,
        workspaceId,
        sessionId,
        isPinned,
        isDisabled: false,
        metadata: tool.metadata,
      };
      entries.push(entry);
    }

    // 6. Compute Monotonic Revision and Build Snapshot
    const currentRevision = this.workspaceRevisions.get(workspaceId) ?? 1;
    const snapshot = buildCatalogSnapshot({
      workspaceId,
      revision: currentRevision,
      entries,
      sessionId,
    });
    this.cache.set(workspaceId, sessionId, snapshot);
    this.recordSnapshot(snapshot);

    if (this.toolRepo?.saveCatalogSnapshot) {
      try {
        await this.toolRepo.saveCatalogSnapshot(snapshot);
      } catch {
        // Fallback for in-memory environments
      }
    }

    return snapshot;
  }

  /**
   * Retrieves a tool by toolId, name, or exposedName within the context of a workspace.
   */
  async getTool(
    toolIdOrName: string,
    workspaceId?: string,
    sessionId?: string,
  ): Promise<RegistryTool | undefined> {
    if (!toolIdOrName) {
      return undefined;
    }

    if (workspaceId) {
      if (isSystemMetaTool(toolIdOrName)) {
        for (const versions of this.registeredTools.values()) {
          for (const t of versions.values()) {
            if (
              (t.toolId === toolIdOrName ||
                t.name === toolIdOrName ||
                t.exposedName === toolIdOrName) &&
              (t.isSystem || isSystemMetaTool(t.toolId))
            ) {
              return { ...t, isDisabled: false };
            }
          }
        }
      }

      const controls = await this.controls.getControls(workspaceId);
      if (controls.disabledTools.includes(toolIdOrName) && !isSystemMetaTool(toolIdOrName)) {
        return undefined;
      }

      const boundLock = this.workspaceLocks.get(workspaceId);
      if (boundLock) {
        const lockedEntry =
          boundLock.tools[toolIdOrName] ??
          Object.values(boundLock.tools).find(
            (e) => e.toolId === toolIdOrName || e.name === toolIdOrName,
          );

        if (!lockedEntry) {
          const systemTool = this.systemActiveTools.get(toolIdOrName);
          if (systemTool) {
            const tool = this.registeredTools.get(toolIdOrName)?.get(systemTool);
            if (tool) return { ...tool, isDisabled: false };
          }
          for (const [toolId, version] of this.systemActiveTools.entries()) {
            const tool = this.registeredTools.get(toolId)?.get(version);
            if (tool && (tool.name === toolIdOrName || tool.exposedName === toolIdOrName)) {
              return { ...tool, isDisabled: false };
            }
          }
          return undefined;
        }

        if (
          lockedEntry.status === "disabled" ||
          (lockedEntry.status as string) === "revoked" ||
          (lockedEntry.status as string) === "blocked"
        ) {
          return undefined;
        }

        if (
          controls.disabledTools.includes(lockedEntry.toolId) ||
          controls.disabledTools.includes(lockedEntry.name)
        ) {
          return undefined;
        }

        let tool = this.registeredTools.get(lockedEntry.toolId)?.get(lockedEntry.version);
        if (!tool) {
          for (const versions of this.registeredTools.values()) {
            const candidate = versions.get(lockedEntry.version);
            if (
              candidate &&
              (candidate.name === lockedEntry.name || candidate.manifest?.name === lockedEntry.name)
            ) {
              tool = candidate;
              break;
            }
          }
        }

        if (!tool) {
          return undefined; // NO latest fallback!
        }

        const validation = validateLockedToolTuple(tool, lockedEntry);
        if (!validation.valid) {
          return undefined;
        }

        return { ...tool, isDisabled: false };
      }

      const catalog = await this.resolveCatalog(workspaceId, sessionId);
      const entry = Object.values(catalog.tools).find(
        (t) =>
          t.toolId === toolIdOrName ||
          (t as CatalogToolSummary & { name?: string }).name === toolIdOrName,
      );

      if (entry) {
        const found = this.registeredTools.get(entry.toolId)?.get(entry.version);
        if (found) {
          return { ...found, isDisabled: false };
        }
      }

      const record = catalog as CatalogSnapshotRecord;
      if (record.entries) {
        for (const e of Object.values(record.entries)) {
          if (
            e.exposedName === toolIdOrName ||
            e.name === toolIdOrName ||
            e.toolId === toolIdOrName
          ) {
            const found = this.registeredTools.get(e.toolId)?.get(e.version);
            if (found) {
              return { ...found, isDisabled: false };
            }
          }
        }
      }

      for (const disabledId of controls.disabledTools) {
        const disabledTool = this.registeredTools.get(disabledId);
        if (disabledTool) {
          for (const t of disabledTool.values()) {
            if (t.name === toolIdOrName || t.exposedName === toolIdOrName) {
              return undefined;
            }
          }
        }
      }
    }

    if (!workspaceId) {
      const directVersions = this.registeredTools.get(toolIdOrName);
      if (directVersions) {
        const latest = this.latestVersions.get(toolIdOrName);
        if (latest) {
          return directVersions.get(latest);
        }
        return directVersions.values().next().value;
      }

      for (const versions of this.registeredTools.values()) {
        for (const tool of versions.values()) {
          if (tool.name === toolIdOrName || tool.exposedName === toolIdOrName) {
            return tool;
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Retrieves a specific version of a registered tool.
   */
  getToolVersion(
    toolIdOrName: string,
    version: string,
    workspaceId?: string,
  ): RegistryTool | undefined {
    if (workspaceId) {
      const boundLock = this.workspaceLocks.get(workspaceId);
      if (boundLock) {
        const lockedEntry =
          boundLock.tools[toolIdOrName] ??
          Object.values(boundLock.tools).find(
            (e) => e.toolId === toolIdOrName || e.name === toolIdOrName,
          );
        if (!lockedEntry) {
          const sysTool = this.registeredTools.get(toolIdOrName)?.get(version);
          if (sysTool && (sysTool.isSystem || isSystemMetaTool(sysTool.toolId))) {
            return sysTool;
          }
          return undefined;
        }
        if (lockedEntry.version !== version) {
          return undefined;
        }
        if (
          lockedEntry.status === "disabled" ||
          (lockedEntry.status as string) === "revoked" ||
          (lockedEntry.status as string) === "blocked"
        ) {
          return undefined;
        }
        let tool = this.registeredTools.get(lockedEntry.toolId)?.get(version);
        if (!tool) {
          for (const versions of this.registeredTools.values()) {
            const candidate = versions.get(version);
            if (
              candidate &&
              (candidate.name === lockedEntry.name || candidate.manifest?.name === lockedEntry.name)
            ) {
              tool = candidate;
              break;
            }
          }
        }
        if (!tool) return undefined;
        const validation = validateLockedToolTuple(tool, lockedEntry);
        if (!validation.valid) return undefined;
        return tool;
      }
    }

    const direct = this.registeredTools.get(toolIdOrName)?.get(version);
    if (direct) {
      return direct;
    }
    for (const versions of this.registeredTools.values()) {
      const vTool = versions.get(version);
      if (vTool && (vTool.name === toolIdOrName || vTool.exposedName === toolIdOrName)) {
        return vTool;
      }
    }
    return undefined;
  }

  /**
   * Atomically activates a tool version in a workspace or session,
   * building a new snapshot revision and notifying listeners.
   */
  async activateToolVersion(
    toolId: string,
    version: string,
    workspaceId: string,
    options?: {
      sessionId?: string;
      scope?: ToolScopeHierarchy;
    },
  ): Promise<CatalogSnapshot> {
    let tool = this.registeredTools.get(toolId)?.get(version);
    if (!tool) {
      for (const versions of this.registeredTools.values()) {
        const candidate = versions.get(version);
        if (
          candidate &&
          (candidate.name === toolId ||
            candidate.exposedName === toolId ||
            candidate.manifest?.name === toolId)
        ) {
          tool = candidate;
          break;
        }
      }
    }
    if (!tool) {
      throw new Error(`Tool '${toolId}' version '${version}' is not registered`);
    }

    const boundLock = this.workspaceLocks.get(workspaceId);
    if (boundLock) {
      const lockedEntry =
        boundLock.tools[toolId] ??
        Object.values(boundLock.tools).find((e) => e.toolId === toolId || e.name === toolId);
      if (!lockedEntry) {
        if (!isSystemMetaTool(toolId) && !tool.isSystem) {
          throw new Error(
            `Cannot activate tool '${toolId}': workspace '${workspaceId}' is bound to a lockfile and tool is not locked`,
          );
        }
      } else {
        if (lockedEntry.version !== version) {
          throw new Error(
            `Cannot activate tool '${toolId}' version '${version}': workspace '${workspaceId}' is locked to exact version '${lockedEntry.version}'`,
          );
        }
        if (
          lockedEntry.status === "disabled" ||
          (lockedEntry.status as string) === "revoked" ||
          (lockedEntry.status as string) === "blocked"
        ) {
          throw new Error(
            `Cannot activate tool '${toolId}': tool is '${lockedEntry.status}' in lockfile`,
          );
        }
      }
    }

    tool.workspaceId = workspaceId;
    if (options?.sessionId) {
      tool.sessionId = options.sessionId;
    }
    if (options?.scope) {
      tool.scope = options.scope;
    }
    // If scope is session, activate in session map
    if (options?.sessionId) {
      let sessMap = this.sessionActiveTools.get(options.sessionId);
      if (!sessMap) {
        sessMap = new Map();
        this.sessionActiveTools.set(options.sessionId, sessMap);
      }
      sessMap.set(tool.toolId, version);
      if (toolId !== tool.toolId) {
        sessMap.set(toolId, version);
      }
    } else if (options?.scope === "system" || tool.scope === "system" || tool.scope === "global") {
      this.systemActiveTools.set(tool.toolId, version);
      if (toolId !== tool.toolId) {
        this.systemActiveTools.set(toolId, version);
      }
    } else {
      let wsMap = this.workspaceActiveTools.get(workspaceId);
      if (!wsMap) {
        wsMap = new Map();
        this.workspaceActiveTools.set(workspaceId, wsMap);
      }
      wsMap.set(tool.toolId, version);
      if (toolId !== tool.toolId) {
        wsMap.set(toolId, version);
      }
    }

    // Monotonically advance revision
    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    // Invalidate LRU cache for workspace
    this.cache.invalidateWorkspace(workspaceId);

    // Rebuild snapshot
    const snapshot = await this.resolveCatalog(workspaceId, options?.sessionId);

    // Emit debounced catalog change event
    this.events.emit({
      workspaceId,
      sessionId: options?.sessionId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Deactivates a tool from a workspace or session catalog.
   */
  async deactivateTool(
    toolId: string,
    workspaceId: string,
    options?: {
      sessionId?: string;
    },
  ): Promise<CatalogSnapshot> {
    let tool = this.registeredTools.get(toolId)?.values().next().value;
    if (!tool) {
      for (const versions of this.registeredTools.values()) {
        for (const candidate of versions.values()) {
          if (
            candidate &&
            (candidate.name === toolId ||
              candidate.exposedName === toolId ||
              candidate.manifest?.name === toolId)
          ) {
            tool = candidate;
            break;
          }
        }
        if (tool) break;
      }
    }
    const boundLock = this.workspaceLocks.get(workspaceId);
    if (boundLock) {
      const lockedEntry =
        boundLock.tools[toolId] ??
        Object.values(boundLock.tools).find((e) => e.toolId === toolId || e.name === toolId);
      if (lockedEntry) {
        throw new Error(
          `Cannot deactivate tool '${toolId}': workspace '${workspaceId}' is bound to a lockfile and tool is locked`,
        );
      }
    }

    if (options?.sessionId) {
      const sessMap = this.sessionActiveTools.get(options.sessionId);
      if (sessMap) {
        sessMap.delete(toolId);
        if (tool) sessMap.delete(tool.toolId);
      }
    } else {
      const wsMap = this.workspaceActiveTools.get(workspaceId);
      if (wsMap) {
        wsMap.delete(toolId);
        if (tool) wsMap.delete(tool.toolId);
      }
      this.systemActiveTools.delete(toolId);
      if (tool) this.systemActiveTools.delete(tool.toolId);
    }

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId, options?.sessionId);

    this.events.emit({
      workspaceId,
      sessionId: options?.sessionId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [tool?.toolId ?? toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Pins a tool version in a workspace, locking it against automated candidate updates.
   */
  async pinToolVersion(toolId: string, version: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot pin invariant system meta-tool '${toolId}'`);
    }
    let tool = this.registeredTools.get(toolId)?.get(version);
    if (!tool) {
      for (const versions of this.registeredTools.values()) {
        const candidate = versions.get(version);
        if (
          candidate &&
          (candidate.name === toolId ||
            candidate.exposedName === toolId ||
            candidate.manifest?.name === toolId)
        ) {
          tool = candidate;
          break;
        }
      }
    }
    if (!tool) {
      throw new Error(`Cannot pin unregistered tool '${toolId}' version '${version}'`);
    }

    await this.controls.pinToolVersion(workspaceId, toolId, version);

    // Also activate it in the workspace
    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.set(tool.toolId, version);
    if (toolId !== tool.toolId) {
      wsMap.set(toolId, version);
    }

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [tool.toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Unpins a tool version, returning it to autonomous update eligibility.
   */
  async unpinToolVersion(toolId: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot unpin invariant system meta-tool '${toolId}'`);
    }
    await this.controls.unpinToolVersion(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Disables a tool in a workspace.
   */
  async disableTool(toolId: string, workspaceId: string): Promise<CatalogSnapshot> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot disable invariant system meta-tool '${toolId}'`);
    }
    await this.controls.disableTool(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }

  /**
   * Enables a tool in a workspace.
   */
  async enableTool(toolId: string, workspaceId: string): Promise<CatalogSnapshot> {
    await this.controls.enableTool(workspaceId, toolId);

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });

    return snapshot;
  }
  /**
   * Rolls back a single tool to an installed version in a workspace.
   */
  async rollbackTool(toolId: string, targetVersion: string, workspaceId: string): Promise<void> {
    if (isSystemMetaTool(toolId)) {
      throw new Error(`Cannot rollback invariant system meta-tool '${toolId}'`);
    }

    let tool = this.registeredTools.get(toolId)?.get(targetVersion);
    if (!tool) {
      for (const versions of this.registeredTools.values()) {
        const candidate = versions.get(targetVersion);
        if (
          candidate &&
          (candidate.name === toolId ||
            candidate.exposedName === toolId ||
            candidate.manifest?.name === toolId)
        ) {
          tool = candidate;
          break;
        }
      }
    }
    if (!tool) {
      throw new Error(
        `Cannot rollback: version '${targetVersion}' is not installed for tool '${toolId}'`,
      );
    }

    await this.controls.pinToolVersion(workspaceId, toolId, targetVersion);
    await this.controls.recordRollback(workspaceId, 0, targetVersion);

    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.set(tool.toolId, targetVersion);
    if (toolId !== tool.toolId) {
      wsMap.set(toolId, targetVersion);
    }

    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);
    this.cache.invalidateWorkspace(workspaceId);

    const snapshot = await this.resolveCatalog(workspaceId);
    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot,
      changedToolIds: [toolId],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Rolls back a workspace catalog to an exact target revision or historical snapshot,
   * atomically restoring referenced tool versions and producing a new immutable snapshot.
   */
  async rollbackCatalog(
    workspaceId: string,
    targetRevision: number | string,
  ): Promise<CatalogSnapshot> {
    const history = this.snapshotHistory.get(workspaceId) ?? [];
    let targetSnapshot: CatalogSnapshot | undefined;

    if (typeof targetRevision === "number") {
      targetSnapshot = history.find((s) => s.revision === targetRevision);
    } else {
      targetSnapshot = history.find(
        (s) => s.snapshotId === targetRevision || String(s.revision) === targetRevision,
      );
    }

    // Try DB if not in memory
    if (
      !targetSnapshot &&
      this.toolRepo?.getCatalogSnapshot &&
      typeof targetRevision === "string"
    ) {
      try {
        const fromDb = await this.toolRepo.getCatalogSnapshot(targetRevision);
        if (fromDb && fromDb.workspaceId === workspaceId) {
          targetSnapshot = fromDb;
        }
      } catch {
        // DB lookup failure fallback
      }
    }

    if (!targetSnapshot) {
      throw new Error(
        `Rollback failed: target revision/snapshot '${targetRevision}' not found for workspace '${workspaceId}'`,
      );
    }

    // Restore active tools to match target snapshot exactly
    let wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) {
      wsMap = new Map();
      this.workspaceActiveTools.set(workspaceId, wsMap);
    }
    wsMap.clear();
    const changedToolIds: string[] = [];
    for (const [toolKey, summary] of Object.entries(targetSnapshot.tools)) {
      const canonicalId = summary.toolId || toolKey;
      wsMap.set(canonicalId, summary.version);
      const regTool =
        this.registeredTools.get(canonicalId)?.get(summary.version) ??
        this.getToolVersion(canonicalId, summary.version);
      if (regTool?.name && regTool.name !== canonicalId) {
        wsMap.set(regTool.name, summary.version);
      }
      if (regTool?.exposedName && regTool.exposedName !== canonicalId) {
        wsMap.set(regTool.exposedName, summary.version);
      }
      changedToolIds.push(canonicalId);
    }

    // Monotonically advance workspace revision for the rollback event
    const nextRevision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, nextRevision);

    await this.controls.recordRollback(workspaceId, targetRevision, targetSnapshot.snapshotId);

    this.cache.invalidateWorkspace(workspaceId);

    const newSnapshot = await this.resolveCatalog(workspaceId);

    this.events.emit({
      workspaceId,
      revision: nextRevision,
      snapshot: newSnapshot,
      changedToolIds,
      timestamp: new Date().toISOString(),
    });

    return newSnapshot;
  }

  private recordSnapshot(snapshot: CatalogSnapshotRecord): void {
    let history = this.snapshotHistory.get(snapshot.workspaceId);
    if (!history) {
      history = [];
      this.snapshotHistory.set(snapshot.workspaceId, history);
    }
    if (!history.some((s) => s.snapshotId === snapshot.snapshotId)) {
      history.push(snapshot);
    }
  }

  /**
   * Retrieves current monotonic revision for a workspace.
   */
  getRevision(workspaceId: string): number {
    return this.workspaceRevisions.get(workspaceId) ?? 1;
  }

  /**
   * Flushes all pending debounced catalog change events.
   */
  flushEvents(): void {
    this.events.flush();
  }

  /**
   * Releases resources, timers, and caches.
   */
  destroy(): void {
    this.events.destroy();
    this.cache.invalidateAll();
  }
  /**
   * Returns the underlying tool repository if configured.
   */
  getToolRepo(): ToolRepoLike | null {
    return this.toolRepo;
  }

  /**
   * Hydrates published/evolved tool versions from the backing store into the in-memory registry.
   */
  async hydrateFromStore(options?: { workspaceId?: string }): Promise<number> {
    if (!this.toolRepo) {
      return 0;
    }
    if (this.hydrationPromise) {
      return this.hydrationPromise;
    }
    const repo = this.toolRepo;
    this.hydrationPromise = (async () => {
      let loadedCount = 0;
      try {
        if (typeof repo.listManifests === "function") {
          const manifests = await repo.listManifests();
          for (const manifest of manifests) {
            const toolId = manifest.id;
            let versionObj: ToolVersion | null = null;
            if (typeof repo.getToolVersion === "function") {
              try {
                versionObj = await repo.getToolVersion(toolId, manifest.version);
              } catch {
                // Ignore
              }
            }
            if (versionObj) {
              if (
                versionObj.status === "deprecated" ||
                (versionObj.status as string) === "revoked" ||
                (versionObj.status as string) === "quarantined"
              ) {
                continue;
              }
              const handler = createEvolvedToolHandler(versionObj);
              const registryTool: RegistryTool = {
                toolId,
                name: manifest.name || toolId,
                exposedName: manifest.name || toolId,
                version: versionObj.version,
                description: manifest.description || `Tool ${manifest.name || toolId}`,
                scope: manifest.scope || "global",
                workspaceId: options?.workspaceId,
                parameters:
                  manifest.parameters && typeof manifest.parameters === "object"
                    ? (manifest.parameters as Record<string, unknown>)
                    : { type: "object", properties: {} },
                status: versionObj.status || "active",
                outputSchema:
                  manifest.outputSchema && typeof manifest.outputSchema === "object"
                    ? (manifest.outputSchema as Record<string, unknown>)
                    : undefined,
                manifest,
                artifact: versionObj.artifact,
                handler,
              };
              this.registerToolSync(registryTool);
              if (!options?.workspaceId && !this.systemActiveTools.has(toolId)) {
                this.systemActiveTools.set(toolId, versionObj.version);
              }
              loadedCount++;
            } else {
              const handler = createEvolvedToolHandler({ manifest });
              const registryTool: RegistryTool = {
                toolId,
                name: manifest.name || toolId,
                exposedName: manifest.name || toolId,
                version: manifest.version,
                description: manifest.description || `Tool ${manifest.name || toolId}`,
                scope: manifest.scope || "global",
                workspaceId: options?.workspaceId,
                parameters:
                  manifest.parameters && typeof manifest.parameters === "object"
                    ? (manifest.parameters as Record<string, unknown>)
                    : { type: "object", properties: {} },
                status: "active",
                outputSchema:
                  manifest.outputSchema && typeof manifest.outputSchema === "object"
                    ? (manifest.outputSchema as Record<string, unknown>)
                    : undefined,
                manifest,
                handler,
              };
              this.registerToolSync(registryTool);
              if (!options?.workspaceId && !this.systemActiveTools.has(toolId)) {
                this.systemActiveTools.set(toolId, manifest.version);
              }
              loadedCount++;
            }
          }
        }

        if (options?.workspaceId && typeof repo.listDeployments === "function") {
          try {
            const deployments = await repo.listDeployments({ workspaceId: options.workspaceId });
            for (const dep of deployments) {
              if (
                dep &&
                typeof dep === "object" &&
                "workspaceId" in dep &&
                "toolId" in dep &&
                "version" in dep &&
                "state" in dep &&
                (dep.state === "promoted" || dep.state === "canary")
              ) {
                const wsId = String(dep.workspaceId);
                let ws = this.workspaceActiveTools.get(wsId);
                if (!ws) {
                  ws = new Map();
                  this.workspaceActiveTools.set(wsId, ws);
                }
                ws.set(String(dep.toolId), String(dep.version));
              }
            }
          } catch {
            // Ignore
          }
        }

        this.cache.invalidateAll();

        if (loadedCount > 0) {
          this.events.emit({
            workspaceId: options?.workspaceId ?? "system",
            revision: this.getRevision(options?.workspaceId ?? "system"),
            snapshot: {
              snapshotId: `snap_${Date.now()}`,
              workspaceId: options?.workspaceId ?? "system",
              timestamp: new Date().toISOString(),
              tools: {},
              digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            },
            changedToolIds: [],
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        // Suppress hydration errors
      } finally {
        this.hydrated = true;
        this.hydrationPromise = undefined;
      }
      return loadedCount;
    })();

    return this.hydrationPromise;
  }

  /**
   * Alias for hydrateFromStore.
   */
  async loadFromStore(options?: { workspaceId?: string }): Promise<number> {
    return this.hydrateFromStore(options);
  }

  /**
   * Refreshes catalog by re-hydrating from the backing store and clearing cache.
   */
  async refresh(workspaceId?: string): Promise<number> {
    return this.hydrateFromStore({ workspaceId });
  }
}
