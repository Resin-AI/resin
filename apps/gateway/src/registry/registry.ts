import fs from "node:fs";
import {
  type CapabilityEnvelope,
  type CatalogSnapshot,
  type CatalogToolSummary,
  type InvocationRecord,
  type ToolArtifact,
  ToolArtifactSchema,
  type ToolManifest,
  ToolManifestSchema,
  type ToolVersion,
  ToolVersionSchema,
  type ToolVersionStatus,
  type V1LockedToolEntry,
  type V1ToolLock,
  V1ToolLockSchema,
  canonicalJson,
  normalizeSha256,
  validateV1ToolLock,
} from "@resin/contracts";
import { LocalDatabaseConnection, ToolRepository } from "@resin/db";
import {
  ArtifactCache,
  DeterministicWorkerSandbox,
  type SafetyGateEvaluator,
} from "@resin/runtime";
import {
  type LocalToolDatedInputs,
  type LocalToolRecordedDefaults,
  requireDatedInputs,
  withRecordedDefaults,
} from "../meta/dated-defaults.js";
import {
  type LocalToolDescriber,
  type ToolInvocationRouter,
  createInvocationRecorder,
  createSystemMetaTools,
  isSystemMetaTool,
} from "../meta/index.js";
import type { LocalToolCommands } from "../meta/learned-commands.js";
import { type LocalToolPrivateValues, scrubPrivateValues } from "../meta/private-values.js";
import type { LocalToolProfile, ToolProfile } from "../meta/tool-profile.js";
import {
  type CallToolResult,
  type JsonRpcParamValue,
  type JsonRpcParams,
  JsonRpcParamsSchema,
} from "../protocol/types.js";
import type { ManagedToolAccess } from "../proxy/tool-access.js";
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
  DbConnectionLike,
  RegistryTool,
  StateStoreLike,
  ToolRegistryOptions,
  ToolRepoLike,
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
export interface LockedToolValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateLockedToolTuple(
  tool: RegistryTool,
  lockedEntry: V1LockedToolEntry,
): LockedToolValidationResult {
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
    String(lockedEntry.status) === "revoked" ||
    String(lockedEntry.status) === "blocked"
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

/**
 * Creates a tool execution handler for an evolved tool version.
 */
export function createEvolvedToolHandler(
  toolVersion:
    | ToolVersion
    | { manifest: ToolManifest; artifact?: ToolArtifact; status?: string; sourceCode?: string },
): ToolHandler {
  return async (context: WorkspaceContext, params: JsonRpcParams, options?: ToolCallOptions) => {
    const manifest = toolVersion.manifest;
    const artifact = "artifact" in toolVersion ? toolVersion.artifact : undefined;
    let sourceCode: string | undefined;
    if (
      "sourceCode" in toolVersion &&
      Object.prototype.toString.call(toolVersion.sourceCode) === "[object String]" &&
      String(toolVersion.sourceCode).trim().length > 0
    ) {
      sourceCode = toolVersion.sourceCode;
    } else if (
      artifact?.sourceCode &&
      Object.prototype.toString.call(artifact.sourceCode) === "[object String]" &&
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
    if (!effectiveArtifactDigest && "artifactDigest" in toolVersion && toolVersion.artifactDigest) {
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
            Object.prototype.toString.call(result.output) === "[object String]"
              ? String(result.output)
              : JSON.stringify(result.output);
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
              text: (err instanceof Error ? err.message : String(err)) || "Tool execution error",
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

export function extractToolRepo(
  db: ToolRepoLike | StateStoreLike | LocalDatabaseConnection | DbConnectionLike | null | undefined,
): ToolRepoLike | null {
  // No store means an in-memory registry. Never fall back to the ambient `~/.resin` state
  // database: a registry built without one (tests, embedders) would otherwise read and write the
  // user's real catalog. Callers that persist (the stdio bridge) open their store explicitly.
  if (!db) {
    return null;
  }
  if (!(db instanceof Object)) {
    return null;
  }
  if (db instanceof ToolRepository) {
    return db;
  }
  if (
    db instanceof LocalDatabaseConnection ||
    ("run" in db && "get" in db && "all" in db && db.run instanceof Function)
  ) {
    // SAFETY: db is confirmed to be LocalDatabaseConnection or duck-typed with query methods.
    return new ToolRepository(db as LocalDatabaseConnection);
  }
  if ("getToolRepository" in db && db.getToolRepository instanceof Function) {
    return db.getToolRepository() ?? null;
  }
  if (
    "tools" in db &&
    db.tools &&
    "saveToolVersion" in db.tools &&
    db.tools.saveToolVersion instanceof Function
  ) {
    return db.tools;
  }
  if ("saveManifest" in db && db.saveManifest instanceof Function) {
    // SAFETY: db is an object containing saveManifest method satisfying ToolRepoLike.
    return db as ToolRepoLike;
  }
  return null;
}

export interface ExtractedToolRepoResult {
  repo: ToolRepoLike | null;
  db: LocalDatabaseConnection | null;
}

export function extractToolRepoWithDb(
  db: ToolRepoLike | StateStoreLike | LocalDatabaseConnection | DbConnectionLike | null | undefined,
): ExtractedToolRepoResult {
  if (!db) {
    return { repo: null, db: null };
  }
  let conn: LocalDatabaseConnection | null = null;
  if (db instanceof LocalDatabaseConnection) {
    conn = db;
  } else if ("run" in db && "get" in db && "all" in db && typeof db.run === "function") {
    conn = db as LocalDatabaseConnection;
  } else if ("conn" in db && db.conn instanceof LocalDatabaseConnection) {
    conn = db.conn;
  }
  const repo = extractToolRepo(db);
  return { repo, db: conn };
}

function isToolRegistryOptions(
  value:
    | ToolRegistryOptions
    | ToolRepoLike
    | LocalDatabaseConnection
    | StateStoreLike
    | DbConnectionLike
    | null
    | undefined,
): value is ToolRegistryOptions {
  return Boolean(
    value &&
      value instanceof Object &&
      !("run" in value) &&
      !("getConnection" in value) &&
      !("saveManifest" in value) &&
      !("tools" in value),
  );
}

function isRegistryDbConnection(
  value:
    | ToolRepoLike
    | LocalDatabaseConnection
    | StateStoreLike
    | DbConnectionLike
    | null
    | undefined,
): value is DbConnectionLike {
  return Boolean(
    value &&
      !(value instanceof LocalDatabaseConnection) &&
      value instanceof Object &&
      "run" in value &&
      value.run instanceof Function &&
      "get" in value &&
      value.get instanceof Function &&
      "all" in value &&
      value.all instanceof Function,
  );
}

function toControlsDbConnection(
  value:
    | ToolRepoLike
    | LocalDatabaseConnection
    | StateStoreLike
    | DbConnectionLike
    | null
    | undefined,
): DbConnectionLike | undefined {
  if (value instanceof LocalDatabaseConnection) {
    return {
      run(sql, params) {
        return value.run(sql, params);
      },
      get<T = Record<string, string | number | boolean | null>>(
        sql: string,
        params?: (string | number | boolean | null)[],
      ) {
        return value.get<T>(sql, params) ?? undefined;
      },
      all<T = Record<string, string | number | boolean | null>>(
        sql: string,
        params?: (string | number | boolean | null)[],
      ) {
        return value.all<T>(sql, params);
      },
    };
  }
  return isRegistryDbConnection(value) ? value : undefined;
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
  private localToolDescriber?: LocalToolDescriber;
  private localToolCommands?: LocalToolCommands;
  private localToolDatedInputs?: LocalToolDatedInputs;
  private localToolPrivateValues?: LocalToolPrivateValues;
  private localToolRecordedDefaults?: LocalToolRecordedDefaults;
  private localToolProfile?: LocalToolProfile;
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
  // Cloud tools a workspace's latest verified catalog snapshot dropped, indexed both ways:
  // workspaceId -> { toolId -> public name, public name -> toolId }.
  private readonly retiredCloudTools = new Map<
    string,
    { ids: Map<string, string>; names: Map<string, string> }
  >();

  // Monotonic local revision counter per workspace
  private readonly workspaceRevisions = new Map<string, number>();
  // Snapshot history per workspace
  private readonly snapshotHistory = new Map<string, CatalogSnapshotRecord[]>();
  private hydrated = false;
  private hydrationPromise?: Promise<number>;
  private readonly dbConnection?: LocalDatabaseConnection;
  private readonly onInvocationRecorded?: (record: InvocationRecord) => Promise<void>;
  private managedToolAccess?: ManagedToolAccess;
  constructor(
    options?:
      | ToolRegistryOptions
      | ToolRepoLike
      | LocalDatabaseConnection
      | StateStoreLike
      | DbConnectionLike
      | null,
  ) {
    let opts: ToolRegistryOptions | undefined;
    let db:
      | ToolRepoLike
      | LocalDatabaseConnection
      | StateStoreLike
      | DbConnectionLike
      | null
      | undefined;
    if (isToolRegistryOptions(options)) {
      opts = options;
      db = options.db;
    } else {
      db = options;
    }
    const extracted = extractToolRepoWithDb(db);
    this.toolRepo = extracted.repo;
    this.dbConnection = extracted.db ?? undefined;
    this.onInvocationRecorded =
      opts?.onInvocationRecorded ??
      (this.dbConnection ? createInvocationRecorder({ db: this.dbConnection }) : undefined);
    this.defaultEnvelope = opts?.defaultEnvelope;
    this.cache = new CatalogCache({ maxSize: opts?.cacheSize });
    const lockMgrOpt = opts?.lockManager;
    const lockMgrsOpt = opts?.lockManagers;
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

  setManagedToolAccess(access: ManagedToolAccess): void {
    this.managedToolAccess = access;
    this.forgetBlockedTools();
  }

  /** Re-read durable denial on discovery, including cached catalogs in sibling processes. */
  private forgetBlockedTools(): void {
    if (!this.managedToolAccess) return;
    // Synchronous sweep over every registered tool; resolve ownership once for the pass.
    const releaseOwners = this.managedToolAccess.beginOwnerSnapshot();
    try {
      for (const tool of this.getAllRegisteredTools()) {
        if (!this.managedToolAccess.isBlocked(tool)) continue;
        this.registeredTools.get(tool.toolId)?.delete(tool.version);
        if (this.latestVersions.get(tool.toolId) === tool.version)
          this.latestVersions.delete(tool.toolId);
        for (const active of [
          this.systemActiveTools,
          ...this.workspaceActiveTools.values(),
          ...this.accountActiveTools.values(),
          ...this.sessionActiveTools.values(),
        ]) {
          if (active.get(tool.toolId) === tool.version) active.delete(tool.toolId);
        }
        for (const [workspaceId, lock] of this.workspaceLocks) {
          const tools = { ...lock.tools };
          for (const [name, entry] of Object.entries(tools)) {
            if (this.managedToolAccess.isBlocked(entry)) delete tools[name];
          }
          this.workspaceLocks.set(workspaceId, { ...lock, tools });
        }
        this.snapshotHistory.clear();
        this.cache.invalidateAll();
      }
    } finally {
      releaseOwners();
    }
  }

  async removeManagedTool(entry: V1LockedToolEntry, workspaceId?: string): Promise<void> {
    this.forgetBlockedTools();
    await this.toolRepo?.removeManagedToolVersion?.(entry, workspaceId);
  }

  /**
   * Evicts, from `workspaceId` only, cloud tools that workspace's latest verified catalog
   * snapshot no longer contains. Every workspace-scoped version leaves discovery, later
   * registrations for the workspace (store hydration, stale caches) are ignored, and handlers
   * captured earlier refuse new calls, until a snapshot carries the tool again. System and
   * global tools are never retired. A call already running when retirement lands is not
   * cancelled; it finishes, and only later calls are refused.
   */
  async retireCloudTools(
    workspaceId: string,
    tools: Array<{ toolId: string; name: string }>,
  ): Promise<void> {
    const retirable = tools.filter(({ toolId }) => !isSystemMetaTool(toolId));
    if (retirable.length === 0) return;
    let retired = this.retiredCloudTools.get(workspaceId);
    if (!retired) {
      retired = { ids: new Map(), names: new Map() };
      this.retiredCloudTools.set(workspaceId, retired);
    }
    const active = this.workspaceActiveTools.get(workspaceId);
    for (const tool of retirable) {
      retired.ids.set(tool.toolId, tool.name);
      retired.names.set(tool.name, tool.toolId);
      active?.delete(tool.toolId);
      const versions = this.registeredTools.get(tool.toolId);
      if (!versions) continue;
      for (const [version, registered] of versions) {
        if (
          registered.workspaceId === workspaceId &&
          !registered.isSystem &&
          registered.scope !== "system" &&
          registered.scope !== "global"
        ) {
          versions.delete(version);
        }
      }
      if (versions.size === 0) {
        this.registeredTools.delete(tool.toolId);
        this.latestVersions.delete(tool.toolId);
      } else if (!versions.has(this.latestVersions.get(tool.toolId) ?? "")) {
        this.latestVersions.set(tool.toolId, [...versions.keys()].at(-1) as string);
      }
    }
    const revision = (this.workspaceRevisions.get(workspaceId) ?? 0) + 1;
    this.workspaceRevisions.set(workspaceId, revision);
    this.cache.invalidateWorkspace(workspaceId);
    const snapshot = await this.resolveCatalog(workspaceId);
    this.events.emit({
      workspaceId,
      revision,
      snapshot,
      changedToolIds: retirable.map((tool) => tool.toolId),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Lets tools a newer verified snapshot of `workspaceId` publishes register and run again. A
   * published name also stops answering as retired, even under a new tool id.
   */
  reinstateCloudTools(workspaceId: string, published: Array<{ id: string; name: string }>): void {
    const retired = this.retiredCloudTools.get(workspaceId);
    if (!retired) return;
    for (const { id, name } of published) {
      const retiredName = retired.ids.get(id);
      retired.ids.delete(id);
      if (retiredName !== undefined && retired.names.get(retiredName) === id) {
        retired.names.delete(retiredName);
      }
      retired.names.delete(name);
    }
  }

  /** Whether `workspaceId`'s latest verified snapshot dropped `toolId`. */
  isCloudToolRetired(workspaceId: string | undefined, toolId: string): boolean {
    return (
      workspaceId !== undefined && this.retiredCloudTools.get(workspaceId)?.ids.has(toolId) === true
    );
  }

  /** The refusal for a tool `workspaceId` retired, addressed by id or public name. */
  retiredToolMessage(identifier: string, workspaceId: string | undefined): string | undefined {
    if (workspaceId === undefined) return undefined;
    const retired = this.retiredCloudTools.get(workspaceId);
    if (!retired) return undefined;
    const name =
      retired.ids.get(identifier) ?? (retired.names.has(identifier) ? identifier : undefined);
    return name === undefined
      ? undefined
      : `Tool '${name}' is no longer available: it was removed from this workspace's catalog. Call search_tools to find the current tool for this job.`;
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

  /** Installs local-only discovery detail, such as the recorded program a learned tool runs. */
  setLocalToolDescriber(describer: LocalToolDescriber): void {
    this.localToolDescriber = describer;
    this.initSystemMetaTools();
  }

  /** Installs the local-only lister of the commands a learned tool's recorded programs run. */
  setLocalToolCommands(lister: LocalToolCommands): void {
    this.localToolCommands = lister;
  }

  /** The commands a learned tool runs on this machine; none without a lister or a program. */
  learnedToolCommands(
    tool: Pick<RegistryTool, "artifactDigest">,
    context: WorkspaceContext,
  ): string[] {
    return this.localToolCommands?.(tool, context) ?? [];
  }

  /** Installs the local-only reader of what a learned tool's cached plan replays and where. */
  setLocalToolProfile(reader: LocalToolProfile): void {
    this.localToolProfile = reader;
  }

  /** A learned tool's local profile (see `ToolProfile`); undefined without a reader or a plan. */
  learnedToolProfile(
    tool: Pick<RegistryTool, "artifactDigest">,
    context: WorkspaceContext,
  ): ToolProfile | undefined {
    return this.localToolProfile?.(tool, context);
  }

  /** Installs the local-only reader of a learned tool's dated recorded-default inputs. */
  setLocalToolDatedInputs(reader: LocalToolDatedInputs): void {
    this.localToolDatedInputs = reader;
  }

  /**
   * The input schema an agent is served for a tool on this machine: `schema` with each input whose
   * recorded default is a date made required (see `requireDatedInputs`). Unchanged without a
   * reader or a dated input; the catalog's schema itself is never modified.
   */
  learnedToolInputSchema<T extends object>(
    tool: Pick<RegistryTool, "artifactDigest">,
    context: WorkspaceContext,
    schema: T,
  ): T {
    const dated = this.localToolDatedInputs?.(tool, context);
    const served = dated === undefined ? schema : requireDatedInputs(schema, dated);
    const values = this.localToolPrivateValues?.(tool, context) ?? [];
    const properties = (served as { properties?: unknown }).properties;
    if (values.length === 0 || properties === null || typeof properties !== "object") return served;
    let scrubbed: Record<string, unknown> | undefined;
    for (const [name, property] of Object.entries(properties)) {
      const description = (property as { description?: unknown } | null)?.description;
      if (typeof description !== "string") continue;
      const shown = scrubPrivateValues(description, values);
      if (shown === description) continue;
      scrubbed ??= { ...(properties as Record<string, unknown>) };
      scrubbed[name] = { ...(property as object), description: shown };
    }
    return scrubbed === undefined ? served : { ...served, properties: scrubbed };
  }

  /** Installs the local-only reader of the private values a learned tool's plan resolves. */
  setLocalToolPrivateValues(reader: LocalToolPrivateValues): void {
    this.localToolPrivateValues = reader;
  }

  /**
   * Meta-tool text about a learned tool with each private value its plan resolves on this machine
   * scrubbed: defense in depth, so no description path can show one to the model.
   */
  scrubLearnedToolText(
    tool: Pick<RegistryTool, "artifactDigest">,
    context: WorkspaceContext,
    text: string,
  ): string {
    const values = this.localToolPrivateValues?.(tool, context) ?? [];
    return values.length === 0 ? text : scrubPrivateValues(text, values);
  }

  /** Installs the local-only reader of a learned tool's non-private recorded defaults. */
  setLocalToolRecordedDefaults(reader: LocalToolRecordedDefaults): void {
    this.localToolRecordedDefaults = reader;
  }

  /**
   * `schema` with each learned-tool input's recorded value as its JSON Schema `default`, only for a
   * value the plan itself carries (see `withRecordedDefaults`); unchanged without a reader.
   */
  withLearnedToolDefaults<T extends object>(
    tool: Pick<RegistryTool, "artifactDigest">,
    context: WorkspaceContext,
    schema: T,
  ): T {
    const defaults = this.localToolRecordedDefaults?.(tool, context);
    return defaults === undefined ? schema : withRecordedDefaults(schema, defaults);
  }

  getSafetyGateEvaluator(): SafetyGateEvaluator | undefined {
    return this.safetyGateEvaluator;
  }

  getInvocationRecorder(): ((record: InvocationRecord) => Promise<void>) | undefined {
    return this.onInvocationRecorded;
  }

  private initSystemMetaTools(): void {
    const metaTools = createSystemMetaTools(
      this,
      this.invocationRouter,
      this.safetyGateEvaluator,
      this.onInvocationRecorded,
      this.localToolDescriber,
    );
    for (const tool of metaTools) {
      this.registerToolSync(tool);
    }
  }

  getDatabaseConnection(): LocalDatabaseConnection | undefined {
    return this.dbConnection;
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
  bindWorkspaceLock(
    workspaceId: string,
    lock: V1ToolLock | JsonRpcParams | null | undefined,
  ): V1ToolLock {
    const parsedLock = V1ToolLockSchema.parse(lock);
    const validatedLock = validateV1ToolLock(parsedLock);
    this.workspaceLocks.set(workspaceId, validatedLock);
    this.cache.invalidateWorkspace(workspaceId);
    return validatedLock;
  }

  /**
   * Alias for bindWorkspaceLock.
   */
  bindLock(workspaceId: string, lock: V1ToolLock | JsonRpcParams | null | undefined): V1ToolLock {
    return this.bindWorkspaceLock(workspaceId, lock);
  }

  /**
   * Alias for bindWorkspaceLock.
   */
  bindProjectLock(
    workspaceId: string,
    lock: V1ToolLock | JsonRpcParams | null | undefined,
  ): V1ToolLock {
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

  validateLockedToolTuple(
    tool: RegistryTool,
    lockedEntry: V1LockedToolEntry,
  ): LockedToolValidationResult {
    return validateLockedToolTuple(tool, lockedEntry);
  }
  /**
   * Pre-stages and validates a tool manifest and artifact against capability envelopes.
   */
  async stageToolVersion(
    manifest: ToolManifest | JsonRpcParams | null | undefined,
    artifact?: ToolArtifact | JsonRpcParams | null | undefined,
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
        artifact instanceof Object &&
        "artifactDigest" in artifact &&
        "bundleReference" in artifact
      ) {
        validatedArtifact = ToolArtifactSchema.parse(artifact);
      } else {
        const rawArt = artifact instanceof Object ? artifact : {};
        const code =
          "code" in rawArt && Object.prototype.toString.call(rawArt.code) === "[object String]"
            ? String(rawArt.code)
            : "sourceCode" in rawArt &&
                Object.prototype.toString.call(rawArt.sourceCode) === "[object String]"
              ? String(rawArt.sourceCode)
              : "";
        const digest =
          "digest" in rawArt && Object.prototype.toString.call(rawArt.digest) === "[object String]"
            ? String(rawArt.digest)
            : computeSha256(code);
        const entrypoint =
          "entrypoint" in rawArt &&
          Object.prototype.toString.call(rawArt.entrypoint) === "[object String]"
            ? String(rawArt.entrypoint)
            : "index.js";
        validatedArtifact = ToolArtifactSchema.parse({
          artifactDigest: digest,
          bundleReference: {
            uri: `memory://${toolId}/${validatedManifest.version}`,
            hash: digest,
            sizeBytes: Buffer.byteLength(code, "utf8"),
            format: "embedded",
          },
          entrypoint,
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
      scope: validatedManifest.scope ?? "workspace",
      manifestDigest: result.manifestDigest,
      artifact: validatedArtifact,
      artifactDigest: result.artifactDigest,
      envelope: targetEnvelope,
      envelopeDigest: targetEnvelope ? computeSha256(canonicalJson(targetEnvelope)) : undefined,
      status: "active",
      description: validatedManifest.description,
      parameters:
        validatedManifest.parameters === undefined
          ? undefined
          : JsonRpcParamsSchema.parse(validatedManifest.parameters),
      outputSchema:
        validatedManifest.outputSchema === undefined
          ? undefined
          : JsonRpcParamsSchema.parse(validatedManifest.outputSchema),
      metadata:
        validatedManifest.metadata === undefined
          ? undefined
          : JsonRpcParamsSchema.parse(validatedManifest.metadata),
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
        // Ignore DB save errors in staging
      }
    }

    return result;
  }

  private getExistingVersionsForManifest(
    rawManifest: ToolManifest | JsonRpcParams | null | undefined,
  ): ToolVersion[] {
    if (!rawManifest || !(rawManifest instanceof Object)) {
      return [];
    }
    const toolId =
      "id" in rawManifest && Object.prototype.toString.call(rawManifest.id) === "[object String]"
        ? String(rawManifest.id)
        : "toolId" in rawManifest &&
            Object.prototype.toString.call(rawManifest.toolId) === "[object String]"
          ? String(rawManifest.toolId)
          : undefined;
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
          status:
            tool.status === "draft" || tool.status === "deprecated" || tool.status === "revoked"
              ? tool.status
              : "active",
          createdAt: tool.createdAt || tool.manifest.createdAt || new Date().toISOString(),
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
    if (this.managedToolAccess?.isBlocked(tool)) return;
    if (this.isCloudToolRetired(tool.workspaceId, tool.toolId)) return;
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
    const handler = tool.handler;
    tool.handler = async (context, params, options) => {
      const retired =
        this.retiredToolMessage(tool.toolId, context.workspaceId) ??
        this.retiredToolMessage(tool.toolId, tool.workspaceId);
      if (retired) throw new Error(retired);
      this.managedToolAccess?.assertAllowed(tool);
      if (
        this.managedToolAccess?.isManaged(tool) &&
        this.registeredTools.get(tool.toolId)?.get(tool.version) !== tool
      ) {
        throw new Error("Managed tool is no longer registered");
      }
      return handler(context, params, options);
    };
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
      const regTool = tool;
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

    const manifest = tool;
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

  /** Changes synchronously with catalog invalidation, before debounced notifications. */
  getCatalogGeneration(): number {
    return this.cache.getGeneration();
  }

  /**
   * Resolves the visible tool catalog for a workspace and optional session,
   * applying scope hierarchy, user pins/disables, name collision resolution,
   * and LRU snapshot caching.
   */
  async resolveCatalog(workspaceId: string, sessionId?: string): Promise<CatalogSnapshot> {
    this.forgetBlockedTools();
    const generation = this.cache.getGeneration();
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
          String(lockedEntry.status) === "revoked" ||
          String(lockedEntry.status) === "blocked"
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
    // Resolve ownership once for this synchronous build: isBlocked() runs per candidate
    // tool and each call re-validated the owners directory, which dominated CPU for
    // large catalogs. No await occurs inside this scope.
    const releaseOwners = this.managedToolAccess?.beginOwnerSnapshot();
    try {
      for (const { tool, scope } of candidateTools.values()) {
        if (this.managedToolAccess?.isBlocked(tool)) continue;
        if (this.isCloudToolRetired(workspaceId, tool.toolId)) continue;
        const exposedName = nameMap.get(tool.toolId) || sanitizeToolName(tool.name);
        const isPinned =
          Boolean(controls.pinnedVersions[tool.toolId]) ||
          Boolean(controls.pinnedVersions[tool.name]) ||
          (tool.exposedName ? Boolean(controls.pinnedVersions[tool.exposedName]) : false);

        const parametersValue = tool.parameters ?? tool.manifest.parameters;
        const outputSchemaValue = tool.outputSchema ?? tool.manifest.outputSchema;
        const parameters =
          parametersValue === undefined ? undefined : JsonRpcParamsSchema.parse(parametersValue);
        const outputSchema =
          outputSchemaValue === undefined
            ? undefined
            : JsonRpcParamsSchema.parse(outputSchemaValue);
        const metadata =
          tool.metadata === undefined ? undefined : JsonRpcParamsSchema.parse(tool.metadata);

        const entry: CatalogEntry = {
          toolId: tool.toolId,
          name: tool.name,
          version: tool.version,
          manifest: tool.manifest,
          manifestDigest:
            tool.manifestDigest || tool.manifest.digest || computeManifestDigest(tool.manifest),
          artifactDigest: tool.artifactDigest || tool.artifact?.artifactDigest,
          envelopeDigest: tool.envelopeDigest,
          scope,
          status: tool.status || "active",
          exposedName,
          parameters,
          outputSchema,
          artifact: tool.artifact,
          handler: tool.handler,
          sourceCode: tool.sourceCode,
          workspaceId,
          sessionId,
          isPinned,
          isDisabled: false,
          metadata,
        };
        entries.push(entry);
      }
    } finally {
      releaseOwners?.();
    }

    // 6. Compute Monotonic Revision and Build Snapshot
    const currentRevision = this.workspaceRevisions.get(workspaceId) ?? 1;
    const snapshot = buildCatalogSnapshot({
      workspaceId,
      revision: currentRevision,
      entries,
      sessionId,
    });
    // An invalidation during hydration/control lookup must not repopulate the
    // active cache with a snapshot assembled against an earlier catalog.
    if (generation === this.cache.getGeneration()) {
      this.cache.set(workspaceId, sessionId, snapshot);
    }
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
    this.forgetBlockedTools();
    if (!toolIdOrName) {
      return undefined;
    }
    if (this.retiredToolMessage(toolIdOrName, workspaceId)) {
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
        // A listed (exposed) name resolves to its own locked tool first; the lock may record a
        // manifest name that differs from it, and a raw name must not shadow another listing.
        const lockEntries = Object.values(boundLock.tools);
        const catalog = await this.resolveCatalog(workspaceId, sessionId);
        const listed =
          "entries" in catalog
            ? Object.values((catalog as CatalogSnapshotRecord).entries ?? {}).find(
                (e) => e.exposedName === toolIdOrName,
              )
            : undefined;
        const lockedEntry =
          (listed
            ? lockEntries.find((e) => e.toolId === listed.toolId && e.version === listed.version)
            : undefined) ??
          boundLock.tools[toolIdOrName] ??
          lockEntries.find((e) => e.toolId === toolIdOrName || e.name === toolIdOrName);

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
          String(lockedEntry.status) === "revoked" ||
          String(lockedEntry.status) === "blocked"
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
      const entry = Object.entries(catalog.tools).find(
        ([exposedName, t]) => exposedName === toolIdOrName || t.toolId === toolIdOrName,
      );
      if (entry) {
        const [, toolSummary] = entry;
        const found = this.registeredTools.get(toolSummary.toolId)?.get(toolSummary.version);
        if (found) {
          return { ...found, isDisabled: false };
        }
      }
      // SAFETY: 'entries' property indicates catalog conforms to CatalogSnapshotRecord structure.
      const record = "entries" in catalog ? (catalog as CatalogSnapshotRecord) : undefined;
      if (record && record.entries) {
        // A listed (exposed) name always resolves to its own entry. A raw manifest name is
        // accepted only when no entry exposes it and exactly one entry carries it, so it can
        // never shadow another tool's listed name.
        const entries = Object.values(record.entries);
        const byExposed = entries.find((e) => e.exposedName === toolIdOrName);
        const byRawName = entries.filter((e) => e.name === toolIdOrName);
        const e =
          byExposed ??
          entries.find((candidate) => candidate.toolId === toolIdOrName) ??
          (byRawName.length === 1 ? byRawName[0] : undefined);
        const found = e ? this.registeredTools.get(e.toolId)?.get(e.version) : undefined;
        if (found) {
          return { ...found, isDisabled: false };
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
          String(lockedEntry.status) === "revoked" ||
          String(lockedEntry.status) === "blocked"
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
  /**
   * Returns true when the tool is already registered and marked active for this
   * workspace at the given version. Used by sync to skip a redundant
   * registerToolSync + activateToolVersion (which rebuilds the whole catalog).
   */
  isToolActiveForWorkspace(
    toolId: string,
    version: string,
    workspaceId: string,
    expected?: { manifestDigest?: string; artifactDigest?: string; envelopeDigest?: string },
  ): boolean {
    const registered = this.registeredTools.get(toolId)?.get(version);
    if (!registered) return false;
    // A same-version entry whose digests changed is a different implementation and
    // must NOT be treated as already active — re-register and re-activate it.
    if (expected) {
      // A present expected digest requires exact equality; a missing registered digest
      // is a mismatch (the registered tool was never pinned to that content).
      if (
        expected.manifestDigest !== undefined &&
        registered.manifestDigest !== expected.manifestDigest
      )
        return false;
      if (
        expected.artifactDigest !== undefined &&
        registered.artifactDigest !== expected.artifactDigest
      )
        return false;
      if (
        expected.envelopeDigest !== undefined &&
        registered.envelopeDigest !== expected.envelopeDigest
      )
        return false;
    }
    const wsMap = this.workspaceActiveTools.get(workspaceId);
    if (!wsMap) return false;
    return wsMap.get(toolId) === version || wsMap.get(registered.name) === version;
  }

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
          String(lockedEntry.status) === "revoked" ||
          String(lockedEntry.status) === "blocked"
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
   * Sets active version of a tool in workspace or system scope.
   */
  setActiveVersion(toolId: string, version: string, workspaceId?: string): void {
    if (workspaceId) {
      let wsTools = this.workspaceActiveTools.get(workspaceId);
      if (!wsTools) {
        wsTools = new Map();
        this.workspaceActiveTools.set(workspaceId, wsTools);
      }
      wsTools.set(toolId, version);
    } else {
      this.systemActiveTools.set(toolId, version);
    }
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
    if (Number.isFinite(targetRevision)) {
      targetSnapshot = history.find((s) => s.revision === targetRevision);
    } else {
      targetSnapshot = history.find(
        (s) => s.snapshotId === targetRevision || String(s.revision) === String(targetRevision),
      );
    }

    // Try DB if not in memory
    if (
      !targetSnapshot &&
      this.toolRepo?.getCatalogSnapshot &&
      Object.prototype.toString.call(targetRevision) === "[object String]"
    ) {
      try {
        const fromDb = await this.toolRepo.getCatalogSnapshot(String(targetRevision));
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
        if ("listManifests" in repo && repo.listManifests instanceof Function) {
          const manifests = await repo.listManifests();
          // Build all RegistryTools first (async getToolVersion per manifest), then
          // register them in one synchronous pass under a single owner snapshot. The
          // snapshot must NOT span the awaits — a revocation landing mid-await would be
          // masked — so it wraps only the synchronous registerToolSync loop.
          const pending: Array<{ tool: RegistryTool; toolId: string; version: string }> = [];
          for (const manifest of manifests) {
            const toolId = manifest.id;
            let versionObj: ToolVersion | null = null;
            if ("getToolVersion" in repo && repo.getToolVersion instanceof Function) {
              try {
                versionObj = await repo.getToolVersion(toolId, manifest.version);
              } catch {
                // Ignore
              }
            }
            if (versionObj) {
              if (
                versionObj.status === "deprecated" ||
                String(versionObj.status) === "revoked" ||
                String(versionObj.status) === "quarantined"
              ) {
                continue;
              }
              const handler = createEvolvedToolHandler(versionObj);
              // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
              const params =
                manifest.parameters && manifest.parameters instanceof Object
                  ? (manifest.parameters as JsonRpcParams)
                  : { type: "object", properties: {} };
              // SAFETY: Manifest output schema conforms to JSON-RPC parameter record structure.
              const outputSchema =
                manifest.outputSchema && manifest.outputSchema instanceof Object
                  ? (manifest.outputSchema as JsonRpcParams)
                  : undefined;
              pending.push({
                tool: {
                  toolId,
                  name: manifest.name || toolId,
                  exposedName: manifest.name || toolId,
                  version: versionObj.version,
                  description: manifest.description || `Tool ${manifest.name || toolId}`,
                  // SAFETY: Manifest scope conforms to ToolScopeHierarchy.
                  scope: (manifest.scope as ToolScopeHierarchy) || "global",
                  workspaceId: options?.workspaceId,
                  parameters: params,
                  status: versionObj.status || "active",
                  outputSchema,
                  manifest,
                  artifact: versionObj.artifact,
                  handler,
                },
                toolId,
                version: versionObj.version,
              });
            } else {
              const handler = createEvolvedToolHandler({ manifest });
              // SAFETY: Manifest parameters conform to JSON-RPC parameter record structure.
              const params =
                manifest.parameters && manifest.parameters instanceof Object
                  ? (manifest.parameters as JsonRpcParams)
                  : { type: "object", properties: {} };
              // SAFETY: Manifest output schema conforms to JSON-RPC parameter record structure.
              const outputSchema =
                manifest.outputSchema && manifest.outputSchema instanceof Object
                  ? (manifest.outputSchema as JsonRpcParams)
                  : undefined;
              pending.push({
                tool: {
                  toolId,
                  name: manifest.name || toolId,
                  exposedName: manifest.name || toolId,
                  version: manifest.version,
                  description: manifest.description || `Tool ${manifest.name || toolId}`,
                  // SAFETY: Manifest scope conforms to ToolScopeHierarchy.
                  scope: (manifest.scope as ToolScopeHierarchy) || "global",
                  workspaceId: options?.workspaceId,
                  parameters: params,
                  status: "active",
                  outputSchema,
                  manifest,
                  handler,
                },
                toolId,
                version: manifest.version,
              });
            }
          }

          // Synchronous registration under one owner snapshot — no awaits inside.
          const releaseOwners = this.managedToolAccess?.beginOwnerSnapshot();
          try {
            for (const { tool, toolId, version } of pending) {
              this.registerToolSync(tool);
              if (!options?.workspaceId && !this.systemActiveTools.has(toolId)) {
                this.systemActiveTools.set(toolId, version);
              }
              loadedCount++;
            }
          } finally {
            releaseOwners?.();
          }
        }

        if (
          options?.workspaceId &&
          "listDeployments" in repo &&
          repo.listDeployments instanceof Function
        ) {
          try {
            const deployments = await repo.listDeployments({ workspaceId: options.workspaceId });
            for (const dep of deployments) {
              if (
                dep &&
                dep instanceof Object &&
                "workspaceId" in dep &&
                "toolId" in dep &&
                "version" in dep &&
                dep.workspaceId === options.workspaceId
              ) {
                this.setActiveVersion(String(dep.toolId), String(dep.version), options.workspaceId);
              }
            }
          } catch {
            // Ignore deployment hydration failure
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
