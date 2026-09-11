import type {
  CapabilityEnvelope,
  NormalizedCommandExecEvent,
  NormalizedSessionEvent,
  SuppressionResult,
} from "@resin/contracts";
import { isActionableStep } from "./episode.js";
import { hasParameterShapeEnvelope } from "./parameter-shape.js";
import { normalizeCommandProfile, normalizePathAlias, splitCompositeCommand } from "./signature.js";
import type {
  Episode,
  RecentOpportunityHashRecord,
  SuppressionOptions,
  WorkflowCluster,
} from "./types.js";

const DEFAULT_MIN_MEANINGFUL_STEPS = 2;

const DESTRUCTIVE_COMMAND_PATTERNS = [
  /\brm\s+-(rf|fr|r|f)\s+(\/|~|\*|\.\/|\.\.)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  /\bchmod\s+(-R\s+)?777\s+(\/|~)/i,
  /\b(drop\s+database|truncate\s+table|drop\s+table)\b/i,
  /\bgit\s+(reset\s+--hard|push\s+--force|clean\s+-fdx)\b/i,
  /\b(cat\s+\/etc\/shadow|cat\s+~\/\.ssh\/id_rsa)\b/i,
  /\bshutdown\s+-h\b/i,
  /\breboot\b/i,
];

const TRIVIAL_COMMANDS: Readonly<Record<string, true>> = Object.fromEntries(
  ["echo", "pwd", "whoami", "hostname", "date", "true", "false", "clear"].map((name) => [
    name,
    true as const,
  ]),
);

/**
 * Tool names that address the synthesis/gateway meta layer or generic placeholder
 * categories, and therefore never describe a synthesizable tool operation.
 */
export const RESERVED_TOOL_NAMES: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "unknown",
    "generic",
    "custom",
    "auto",
    "auto_general",
    "general",
    "passthrough",
    "unknown_passthrough",
    "session_lifecycle",
    "message",
    "thinking",
    "undefined",
    "null",
    "nan",
    "none",
    "__proto__",
    "proto",
    "prototype",
    "constructor",
    "search_tools",
    "get_tool_schema",
    "invoke_tool",
    "manage_tools",
  ].map((name) => [name, true as const]),
);

/**
 * Built-in harness tools plus reserved names, which a synthesized custom tool must not shadow.
 */
export const RESERVED_OR_BUILTIN_TOOL_NAMES: Readonly<Record<string, true>> = Object.fromEntries(
  [
    // Meta tools
    "search_tools",
    "get_tool_schema",
    "invoke_tool",
    "manage_tools",
    // Shell / command tools
    "bash",
    "sh",
    "exec",
    "command_exec",
    "shell",
    "terminal",
    "exec_command",
    "cmd",
    // File tools
    "file_read",
    "read",
    "read_file",
    "cat",
    "head",
    "tail",
    "view",
    "file_edit",
    "edit",
    "write",
    "write_file",
    "patch",
    "replace",
    "sed",
    // Search tools
    "grep",
    "glob",
    "find",
    "search",
    "rg",
    "ripgrep",
    "ag",
    // System / runtime tools & keywords
    "eval",
    "computer",
    "web_search",
    "browser",
    "system",
    "admin",
    "root",
    "process",
    "spawn",
    "node",
    "python",
    // Generic placeholders
    "unknown",
    "generic",
    "custom",
    "auto",
    "auto_general",
    "general",
    "passthrough",
    "unknown_passthrough",
    "undefined",
    "null",
    "nan",
    "none",
    "message",
    "thinking",
    "session_lifecycle",
    // Prototype pollution & object properties
    "__proto__",
    "proto",
    "prototype",
    "constructor",
    "object",
    "function",
    "tostring",
    "valueof",
    "hasownproperty",
    "isprototypeof",
    "propertyisenumerable",
    "__definegetter__",
    "__definesetter__",
    "__lookupgetter__",
    "__lookupsetter__",
  ].map((name) => [name, true as const]),
);

export function isSafeCustomToolName(name: string): boolean {
  if (!name || name.length < 2 || name.length > 64) return false;
  if (/^\d+$/.test(name)) return false;
  const lower = name.toLowerCase();
  if (
    lower === "__proto__" ||
    lower === "proto" ||
    lower === "prototype" ||
    lower === "constructor" ||
    lower.includes("proto") ||
    lower.includes("constructor")
  ) {
    return false;
  }
  if (RESERVED_OR_BUILTIN_TOOL_NAMES[lower] === true) return false;
  return /^[a-z][a-z0-9_]*$/.test(name);
}

/**
 * Rejects reserved or prototype-polluting names before they are counted as tool operations.
 * `__proto__`/`constructor` substrings fail closed because inherited property lookups
 * elsewhere could otherwise resolve to attacker-controlled prototype members.
 */
export function isSafeToolOperationName(name?: string): boolean {
  if (!name || typeof name !== "string") return false;
  const lower = name.toLowerCase().trim();
  if (!lower || lower.length === 0) return false;
  if (RESERVED_TOOL_NAMES[lower] === true) return false;
  if (
    lower === "__proto__" ||
    lower === "proto" ||
    lower === "prototype" ||
    lower === "constructor" ||
    lower.includes("proto") ||
    lower.includes("constructor")
  ) {
    return false;
  }
  return true;
}

/**
 * Command-profile placeholder vocabulary and matcher.
 *
 * Ported from `packages/runtime/src/policy/command-template.ts`, which the observer cannot
 * import: `@resin/runtime` depends on `@resin/observer`, so importing it here would close a
 * workspace dependency cycle. Semantics (and the envelope placeholder classes) must stay in
 * lockstep with the runtime copy: the same expression authorizes a synthesized tool's command
 * at synthesis time and at execution time.
 */
const COMMAND_PLACEHOLDER_CLASSES: Record<string, string> = {
  $STR: "[^\\s]+",
  $NUM: "-?\\d+(\\.\\d+)?",
  $URL: "https?://[^\\s]+",
  $GLOB: "[^\\s]+",
  $PATH: "[^\\s-][^\\s]*",
  $SRC_FILE: "[^\\s-][^\\s]*",
  $TEST_FILE: "[^\\s-][^\\s]*",
  $CONFIG_FILE: "[^\\s-][^\\s]*",
  $DOC_FILE: "[^\\s-][^\\s]*",
  $BUILD_DIR: "[^\\s-][^\\s]*",
  $TMP_DIR: "[^\\s-][^\\s]*",
};

const PLACEHOLDER_PATTERN = new RegExp(
  Object.keys(COMMAND_PLACEHOLDER_CLASSES)
    .sort((left, right) => right.length - left.length)
    .map((placeholder) => placeholder.replace("$", "\\$"))
    .join("|"),
  "g",
);

function compileCommandProfileArg(token: string): RegExp {
  let source = "";
  let cursor = 0;

  for (const match of token.matchAll(PLACEHOLDER_PATTERN)) {
    const placeholder = match[0];
    source += token.slice(cursor, match.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    source += `(?:${COMMAND_PLACEHOLDER_CLASSES[placeholder]})`;
    cursor = (match.index ?? 0) + placeholder.length;
  }

  source += token.slice(cursor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${source}$`);
}

/**
 * Checks whether an envelope entry authorizes a requested command profile.
 * Envelope tokens may be literals or `$PLACEHOLDER` classes; the requested profile may not be
 * longer than the envelope entry, and the executable token must match exactly.
 */
export function commandProfileAuthorizes(envelopeEntry: string, requested: string): boolean {
  const envelopeTrimmed = envelopeEntry.trim();
  const requestedTrimmed = requested.trim();
  const envelopeTokens = envelopeTrimmed.length === 0 ? [] : envelopeTrimmed.split(/\s+/);
  const requestedTokens = requestedTrimmed.length === 0 ? [] : requestedTrimmed.split(/\s+/);
  if (
    envelopeTokens.length === 0 ||
    requestedTokens.length < envelopeTokens.length ||
    envelopeTokens[0] !== requestedTokens[0]
  ) {
    return false;
  }

  for (let index = 1; index < envelopeTokens.length; index++) {
    const envelopeToken = envelopeTokens[index];
    const requestedToken = requestedTokens[index];
    const envelopeIsPlaceholder = envelopeToken.match(PLACEHOLDER_PATTERN) !== null;
    if (!envelopeIsPlaceholder) {
      if (envelopeToken !== requestedToken) {
        return false;
      }
      continue;
    }

    const requestedIsPlaceholder = requestedToken.match(PLACEHOLDER_PATTERN) !== null;
    if (requestedIsPlaceholder) {
      if (envelopeToken !== requestedToken) {
        return false;
      }
      continue;
    }

    if (!compileCommandProfileArg(envelopeToken).test(requestedToken)) {
      return false;
    }
  }

  return true;
}

/**
 * A single operation of the representative workflow, addressable by the same
 * `op_<index>` id space used by the derived workflow contract.
 */
interface OperationRef {
  operationId: string;
  eventId: string;
  event: NormalizedSessionEvent;
}

/**
 * Envelope constraint violations for one capability domain (command, net, fs).
 * Suppression is authoritative only when the constraint is violated for every
 * entity it governs; otherwise only the offending operations are excluded.
 */
interface EnvelopeConstraintViolation {
  reason: string;
  pervasive: boolean;
}

interface DestructiveOperationsCheckResult {
  /** True only when every command operation in the cluster is destructive. */
  isDestructive: boolean;
  reason: string;
  /** Event ids of destructive operations excluded from an otherwise viable cluster. */
  offendingEventIds: string[];
  /** `op_<index>` ids of those operations when they belong to the representative workflow. */
  offendingOperationIds: string[];
}

interface EnvelopeViolationCheckResult {
  /** True only when a violated constraint covers every operation it governs. */
  violates: boolean;
  reason: string;
  /** Event ids of out-of-envelope operations excluded from an otherwise viable cluster. */
  offendingEventIds: string[];
  /** `op_<index>` ids of those operations when they belong to the representative workflow. */
  offendingOperationIds: string[];
}

interface TrivialWorkflowCheckResult {
  isTrivial: boolean;
  reason: string;
}

interface UnobservableCheckResult {
  isUnobservable: boolean;
  reason: string;
}

/**
 * Deterministic event ordering, mirroring the cloud workflow-contract extraction so that
 * operation ids computed here address the same operations as a derived workflow contract.
 */
function sortEventsDeterministically(events: NormalizedSessionEvent[]): NormalizedSessionEvent[] {
  return [...events].sort((a, b) => {
    const aSeq = a.causalRef?.causalSequence ?? 0;
    const bSeq = b.causalRef?.causalSequence ?? 0;
    if (aSeq !== bSeq) return aSeq - bSeq;
    const aTime = Date.parse(a.timestamp ?? "") || 0;
    const bTime = Date.parse(b.timestamp ?? "") || 0;
    if (aTime !== bTime) return aTime - bTime;
    const ai = a.eventId ?? "";
    const bi = b.eventId ?? "";
    if (ai && bi) return ai.localeCompare(bi);
    return String(a.type).localeCompare(String(b.type));
  });
}

/**
 * Representative episode selection, mirroring the cloud workflow-contract extraction.
 */
function selectRepresentativeEpisode(cluster: WorkflowCluster): Episode | undefined {
  if (!cluster.episodes || cluster.episodes.length === 0) return undefined;
  const sorted = [...cluster.episodes].sort((a, b) => {
    const sa = a.sessionId.localeCompare(b.sessionId);
    if (sa !== 0) return sa;
    const ida = a.id.localeCompare(b.id);
    if (ida !== 0) return ida;
    const ta = Date.parse(a.startedAt) || 0;
    const tb = Date.parse(b.startedAt) || 0;
    if (ta !== tb) return ta - tb;
    return a.turnIndex - b.turnIndex;
  });
  return sorted[0];
}

/**
 * Actionable operations of the representative workflow in `op_<index>` id space.
 * This is the set synthesis would turn into tool operations, so exclusions expressed
 * against these ids let downstream synthesis drop exactly the offending operations.
 */
function buildRepresentativeOperations(cluster: WorkflowCluster): OperationRef[] {
  const representative = selectRepresentativeEpisode(cluster);
  if (!representative) return [];
  return sortEventsDeterministically(representative.events)
    .filter(isActionableStep)
    .map((event, index) => ({
      operationId: `op_${index}`,
      eventId: event.eventId ?? "",
      event,
    }));
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
    );
  }
  return [];
}

/**
 * Command profiles an operation's event contributes to the cluster signature.
 * Mirrors the signature extractor: one profile per `command_exec`, one per composite
 * segment for shell-style `tool_call` command parameters.
 */
function eventCommandProfiles(event: NormalizedSessionEvent): string[] {
  const profiles: string[] = [];
  if (event.type === "command_exec") {
    const command = (event.command ?? "").trim();
    if (!command) return profiles;
    const args =
      Array.isArray(event.args) && event.args.length > 0
        ? event.args.filter((arg): arg is string => typeof arg === "string" && arg.length > 0)
        : [];
    const profile =
      args.length > 0
        ? normalizeCommandProfile(`${command.split(/\s+/)[0] ?? ""} ${args.join(" ")}`.trim())
        : normalizeCommandProfile(command);
    if (profile) profiles.push(profile);
    return profiles;
  }

  if (event.type === "tool_call") {
    if (hasParameterShapeEnvelope(event.parameters)) return profiles;
    const params = event.parameters as Record<string, unknown> | undefined;
    const rawCommand =
      params && typeof params === "object"
        ? (params.command ?? params.cmd ?? params.executable)
        : undefined;
    if (typeof rawCommand !== "string" || !rawCommand.trim()) return profiles;
    for (const segment of splitCompositeCommand(rawCommand.trim())) {
      const profile = normalizeCommandProfile(segment.trim());
      if (profile && !profiles.includes(profile)) profiles.push(profile);
    }
  }

  return profiles;
}

/**
 * Raw path evidence carried by an operation's originating event.
 */
function eventPathEvidence(event: NormalizedSessionEvent): string[] {
  const paths: string[] = [];
  if (event.type === "file_edit") {
    if (event.filePath) paths.push(event.filePath);
    return paths;
  }

  if (event.type === "command_exec") {
    const command = event.command ?? "";
    const args =
      Array.isArray(event.args) && event.args.length > 0
        ? event.args.filter((arg): arg is string => typeof arg === "string")
        : command.trim().split(/\s+/).slice(1);
    for (const token of args) {
      if (
        token.includes("/") ||
        /\.(ts|tsx|js|jsx|json|md|yaml|yml|rs|toml|py|sh|sql)$/i.test(token)
      ) {
        paths.push(token);
      }
    }
    if (event.cwd) paths.push(event.cwd);
    return paths;
  }

  if (event.type === "tool_call") {
    if (hasParameterShapeEnvelope(event.parameters)) return paths;
    const params = event.parameters as Record<string, unknown> | undefined;
    if (!params || typeof params !== "object") return paths;
    for (const key of ["path", "filePath", "file", "paths", "targetPaths", "files", "filePaths"]) {
      paths.push(...readStringArray(params[key]));
    }
  }

  return paths;
}

/**
 * Workflow opportunity suppression engine.
 * Suppresses trivial, out-of-envelope, destructive, unobservable, or in-progress/published workflows.
 */
export class SuppressionEngine {
  private readonly minMeaningfulSteps: number;
  private readonly disallowedCommands: string[];

  constructor(options: SuppressionOptions = {}) {
    this.minMeaningfulSteps = options.minMeaningfulSteps ?? DEFAULT_MIN_MEANINGFUL_STEPS;
    this.disallowedCommands = options.disallowedCommands ?? [];
  }

  /**
   * Evaluates if a workflow cluster or episode should be suppressed from opportunity creation.
   */
  evaluateSuppression(
    cluster: WorkflowCluster,
    options: {
      envelope?: CapabilityEnvelope;
      recentOpportunityHashes?:
        | Set<string>
        | Map<string, number>
        | Map<string, Date>
        | Map<string, RecentOpportunityHashRecord>;
      now?: number;
    } = {},
  ): SuppressionResult {
    const now = options.now ?? Date.now();

    // 1. Check Recent Lifecycle Outcome Suppression Window
    if (options.recentOpportunityHashes) {
      const hash = cluster.structuralHash;
      let record: RecentOpportunityHashRecord | undefined;

      if (options.recentOpportunityHashes instanceof Set) {
        if (options.recentOpportunityHashes.has(hash)) {
          record = {
            lastSeenAt: new Date(now),
            outcome: "in_progress",
            attempts: 1,
          };
        }
      } else if (options.recentOpportunityHashes instanceof Map) {
        const rawEntry = options.recentOpportunityHashes.get(hash);
        if (rawEntry !== undefined && rawEntry !== null) {
          if (rawEntry instanceof Date) {
            record = {
              lastSeenAt: rawEntry,
              outcome: "in_progress",
              attempts: 1,
            };
          } else if (typeof rawEntry === "number") {
            record = {
              lastSeenAt: new Date(rawEntry),
              outcome: "in_progress",
              attempts: 1,
            };
          } else if (typeof rawEntry === "object") {
            const rawObj = rawEntry as {
              lastSeenAt?: Date | number | string;
              outcome?: RecentOpportunityHashRecord["outcome"];
              attempts?: number;
            };
            const parsedDate =
              rawObj.lastSeenAt instanceof Date
                ? rawObj.lastSeenAt
                : typeof rawObj.lastSeenAt === "number" || typeof rawObj.lastSeenAt === "string"
                  ? new Date(rawObj.lastSeenAt)
                  : new Date(now);

            record = {
              lastSeenAt: Number.isNaN(parsedDate.getTime()) ? new Date(now) : parsedDate,
              outcome: rawObj.outcome ?? "in_progress",
              attempts:
                typeof rawObj.attempts === "number" && rawObj.attempts > 0 ? rawObj.attempts : 1,
            };
          }
        }
      }

      if (record) {
        if (record.outcome === "published") {
          return {
            suppressed: true,
            reason: "already_learned",
            details: `Workflow with structural hash ${hash.slice(0, 12)} has already been learned and published as an active tool.`,
          };
        }

        if (record.outcome === "in_progress") {
          return {
            suppressed: true,
            reason: "in_progress",
            details: `Workflow with structural hash ${hash.slice(0, 12)} is currently in progress across candidate lifecycle.`,
          };
        }

        // "rejected_on_merit", "failed_infra", and "not_dispatched" -> no suppression, proceed to remaining checks
      }
    }

    // Operations excluded from an otherwise viable cluster because they alone violated
    // a destructive or envelope constraint. Ids address the derived workflow contract's
    // `op_<index>` space so downstream synthesis can drop them from the generated tool.
    const representativeOperations = buildRepresentativeOperations(cluster);
    const excludedEventIds = new Set<string>();
    const excludedOperationIds = new Set<string>();

    // 2. Check Destructive Patterns (scoped: only a fully destructive cluster is suppressed)
    const destructiveCheck = this.checkDestructiveOperations(cluster, representativeOperations);
    if (destructiveCheck.isDestructive) {
      return {
        suppressed: true,
        reason: "destructive",
        details: destructiveCheck.reason,
      };
    }
    for (const eventId of destructiveCheck.offendingEventIds) excludedEventIds.add(eventId);
    for (const operationId of destructiveCheck.offendingOperationIds) {
      excludedOperationIds.add(operationId);
    }

    // 3. Check Out-of-Envelope (if envelope provided; scoped to violated operations)
    if (options.envelope) {
      const envelopeCheck = this.checkEnvelopeViolation(
        cluster,
        options.envelope,
        representativeOperations,
      );
      if (envelopeCheck.violates) {
        return {
          suppressed: true,
          reason: "out_of_envelope",
          details: envelopeCheck.reason,
        };
      }
      for (const eventId of envelopeCheck.offendingEventIds) excludedEventIds.add(eventId);
      for (const operationId of envelopeCheck.offendingOperationIds) {
        excludedOperationIds.add(operationId);
      }
    }

    // Materialized once: exclusions only exist for clusters that survived both scoped checks.
    const exclusions: Pick<SuppressionResult, "excludedEventIds" | "excludedOperationIds"> = {
      ...(excludedEventIds.size > 0 ? { excludedEventIds: [...excludedEventIds] } : {}),
      ...(excludedOperationIds.size > 0
        ? {
            excludedOperationIds: [...excludedOperationIds].sort((a, b) => {
              const ai = Number.parseInt(a.replace(/^op_/, ""), 10);
              const bi = Number.parseInt(b.replace(/^op_/, ""), 10);
              const aIdx = Number.isFinite(ai) ? ai : Number.MAX_SAFE_INTEGER;
              const bIdx = Number.isFinite(bi) ? bi : Number.MAX_SAFE_INTEGER;
              return aIdx - bIdx || a.localeCompare(b);
            }),
          }
        : {}),
    };

    // 4. Check Known Trivial Utility Commands (e.g. pwd, cd, whoami)
    for (const cmd of cluster.representativeSignature.commandPatterns) {
      const root = cmd.split(":")[0];
      if (TRIVIAL_COMMANDS[root] === true) {
        return {
          suppressed: true,
          reason: "trivial",
          details: `Single trivial utility command '${root}'`,
          ...exclusions,
        };
      }
    }

    // 5. Check Tool Operations (< 2 safe tool operations)
    const toolOpsCheck = this.checkToolOperations(cluster);
    if (!toolOpsCheck.hasEnoughToolOperations) {
      return {
        suppressed: true,
        reason: "no_tool_operations",
        details: toolOpsCheck.reason,
        ...exclusions,
      };
    }

    // 6. Check Trivial Workflows (minimal execution time / tokens)
    const trivialCheck = this.checkTrivialWorkflow(cluster);
    if (trivialCheck.isTrivial) {
      return {
        suppressed: true,
        reason: "trivial",
        details: trivialCheck.reason,
        ...exclusions,
      };
    }

    // 7. Check Unobservable Workflows
    const unobservableCheck = this.checkUnobservable(cluster);
    if (unobservableCheck.isUnobservable) {
      return {
        suppressed: true,
        reason: "unobservable",
        details: unobservableCheck.reason,
        ...exclusions,
      };
    }
    return {
      suppressed: false,
      reason: "none",
      details: "Workflow is eligible and meets all viability criteria.",
      ...exclusions,
    };
  }

  /**
   * Computes the number of tool operations in a cluster.
   * Counts tool_call and tool_result events with safe, non-reserved tool names across episodes.
   */
  private checkToolOperations(cluster: WorkflowCluster): {
    hasEnoughToolOperations: boolean;
    toolOperationCount: number;
    reason: string;
  } {
    const toolCallNameById = new Map<string, string>();
    let toolOperationCount = 0;

    for (const ep of cluster.episodes ?? []) {
      for (const evt of ep.events ?? []) {
        if (evt.type === "tool_call") {
          const toolName = evt.toolName ?? "";
          const eventId = evt.eventId ?? ("id" in evt ? String(evt.id) : "");
          if (eventId && toolName) {
            toolCallNameById.set(eventId, toolName);
          }
          if (isSafeToolOperationName(toolName)) {
            toolOperationCount++;
          }
        } else if (evt.type === "tool_result") {
          const resObj = evt as unknown as Record<string, unknown>;
          const rawToolCallId =
            typeof resObj.toolCallId === "string" ? resObj.toolCallId : undefined;
          let toolName: string | undefined =
            typeof resObj.toolName === "string" ? resObj.toolName : undefined;
          if (!toolName && rawToolCallId) {
            toolName = toolCallNameById.get(rawToolCallId);
          }
          if (toolName && isSafeToolOperationName(toolName)) {
            toolOperationCount++;
          }
        } else if (evt.type === "command_exec") {
          const cmd = (evt.command ?? "").trim();
          const exe = cmd.split(/\s+/)[0] ?? "";
          if (exe && isSafeToolOperationName(exe)) {
            toolOperationCount++;
          }
        }
      }
    }

    // Fallback if episodes is empty but representativeSignature is present
    if ((cluster.episodes ?? []).length === 0 && cluster.representativeSignature) {
      const sig = cluster.representativeSignature;
      for (const op of sig.operations ?? []) {
        if (op.startsWith("tool:")) {
          const raw = op
            .replace(/^tool:/, "")
            .toLowerCase()
            .trim();
          if (isSafeToolOperationName(raw)) {
            toolOperationCount++;
          }
        }
      }
    }

    if (toolOperationCount < 2) {
      return {
        hasEnoughToolOperations: false,
        toolOperationCount,
        reason: `Workflow contains ${toolOperationCount} tool operations (requires at least 2 safe tool operations).`,
      };
    }

    return {
      hasEnoughToolOperations: true,
      toolOperationCount,
      reason: "",
    };
  }

  /**
   * Collects destructive operations across cluster episodes instead of suppressing on first match.
   *
   * The cluster is suppressed only when every command operation is destructive; a destructive
   * operation among viable ones is reported for exclusion so the remaining pattern survives.
   */
  private checkDestructiveOperations(
    cluster: WorkflowCluster,
    representativeOperations: OperationRef[],
  ): DestructiveOperationsCheckResult {
    const commandEvents: Array<{ eventId: string; event: NormalizedCommandExecEvent }> = [];
    const seenEvents = new WeakSet<NormalizedSessionEvent>();
    for (const ep of cluster.episodes ?? []) {
      for (const evt of ep.events ?? []) {
        if (evt.type !== "command_exec") continue;
        if (seenEvents.has(evt)) continue;
        seenEvents.add(evt);
        commandEvents.push({ eventId: evt.eventId ?? "", event: evt });
      }
    }

    const offendingEventIds: string[] = [];
    let offendingCount = 0;
    let firstReason = "";
    for (const { eventId, event } of commandEvents) {
      const cmd = event.command ?? "";
      let reason: string | undefined;
      for (const pattern of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (pattern.test(cmd)) {
          reason = `Detected destructive command pattern '${cmd}'`;
          break;
        }
      }
      if (!reason) {
        for (const disallowed of this.disallowedCommands) {
          if (cmd.includes(disallowed)) {
            reason = `Command contains explicitly disallowed string '${disallowed}'`;
            break;
          }
        }
      }
      if (!reason) continue;
      offendingCount++;
      if (eventId) offendingEventIds.push(eventId);
      if (!firstReason) firstReason = reason;
    }

    const isDestructive = commandEvents.length > 0 && offendingCount >= commandEvents.length;
    const operationIdByEventId = new Map<string, string>();
    for (const operation of representativeOperations) {
      if (operation.eventId) operationIdByEventId.set(operation.eventId, operation.operationId);
    }
    const offendingOperationIds = offendingEventIds
      .map((eventId) => operationIdByEventId.get(eventId))
      .filter((operationId): operationId is string => operationId !== undefined);

    // Only the pervasive case surfaces the reason; a scoped exclusion is reported as data.
    const reason =
      isDestructive || !firstReason
        ? firstReason
        : `Excluded ${offendingCount} of ${commandEvents.length} command operations: ${firstReason}`;

    return {
      isDestructive,
      reason,
      offendingEventIds,
      offendingOperationIds,
    };
  }

  /**
   * Collects capability-envelope violations instead of suppressing on the first offending entry.
   *
   * Each constraint domain is evaluated against the operations it governs: command rules against
   * the cluster's command patterns, filesystem deny paths against its normalized paths, and
   * outbound network against network-class operations. A domain only suppresses the whole cluster
   * when every operation it governs violates it; otherwise the violating operations are reported
   * for exclusion and the rest of the workflow stays eligible.
   */
  private checkEnvelopeViolation(
    cluster: WorkflowCluster,
    envelope: CapabilityEnvelope,
    representativeOperations: OperationRef[],
  ): EnvelopeViolationCheckResult {
    // Check frozen envelope
    if (envelope.isFrozen) {
      return {
        violates: true,
        reason:
          "Capability envelope for this workspace is frozen; new tool synthesis is disallowed.",
        offendingEventIds: [],
        offendingOperationIds: [],
      };
    }

    const violations: EnvelopeConstraintViolation[] = [];
    const offendingPatterns = new Set<string>();
    const offendingPaths = new Set<string>();

    // Check command capability
    if (envelope.command) {
      const allowShellExecution = envelope.command.allowShellExecution;
      const allowedCommands = envelope.command.allowedCommands ?? [];
      const allowedBinaries = envelope.command.allowedBinaries ?? [];
      const forbiddenPatterns = envelope.command.forbiddenPatterns ?? [];
      const commandPatterns = cluster.representativeSignature.commandPatterns;
      let reason = "";

      for (const cmdPattern of commandPatterns) {
        const cmdName = cmdPattern.trim().split(/\s+/)[0]!;
        let violation = "";
        for (const forbidden of forbiddenPatterns) {
          if (cmdPattern.includes(forbidden) || cmdName.includes(forbidden)) {
            violation = `Command '${cmdName}' matches forbidden pattern '${forbidden}' in capability envelope.`;
            break;
          }
        }
        if (
          !violation &&
          !allowShellExecution &&
          !allowedCommands.some((entry) => commandProfileAuthorizes(entry, cmdPattern)) &&
          !allowedBinaries.includes(cmdName)
        ) {
          violation = `Command '${cmdName}' is not permitted by capability envelope command whitelist.`;
        }
        if (!violation) continue;
        offendingPatterns.add(cmdPattern);
        if (!reason) reason = violation;
      }

      const governedCommandCount = new Set(commandPatterns).size;
      violations.push({
        reason,
        pervasive: governedCommandCount > 0 && offendingPatterns.size >= governedCommandCount,
      });
    }

    // Check net capability. Outbound denial applies to every network operation, so it always
    // poisons the whole workflow when the cluster performs network access.
    if (envelope.net) {
      const allowOutbound = envelope.net.allowOutbound;
      const hasNetClass = cluster.representativeSignature.toolClasses.includes("network");
      if (hasNetClass && !allowOutbound) {
        violations.push({
          reason: "Network access requested by workflow but allowOutbound is disabled in envelope.",
          pervasive: true,
        });
      }
    }

    // Check fs capability
    if (envelope.fs?.denyPaths && envelope.fs.denyPaths.length > 0) {
      const denyPaths = envelope.fs.denyPaths;
      const normalizedPaths = cluster.representativeSignature.normalizedPaths;
      let reason = "";

      for (const path of normalizedPaths) {
        for (const denyPath of denyPaths) {
          if (path.includes(denyPath)) {
            offendingPaths.add(path);
            if (!reason) {
              reason = `Filesystem path '${path}' violates denied path '${denyPath}' in envelope.`;
            }
            break;
          }
        }
      }

      const governedPathCount = new Set(normalizedPaths).size;
      violations.push({
        reason,
        pervasive: governedPathCount > 0 && offendingPaths.size >= governedPathCount,
      });
    }

    const pervasiveViolation = violations.find((violation) => violation.pervasive);
    if (pervasiveViolation) {
      return {
        violates: true,
        reason: pervasiveViolation.reason,
        offendingEventIds: [],
        offendingOperationIds: [],
      };
    }

    // No constraint poisons the whole cluster: exclude only the offending operations.
    const offendingEventIds = new Set<string>();
    const offendingOperationIds = new Set<string>();
    const excludeOperation = (operation: OperationRef) => {
      if (operation.eventId) offendingEventIds.add(operation.eventId);
      offendingOperationIds.add(operation.operationId);
    };

    if (offendingPatterns.size > 0) {
      for (const operation of representativeOperations) {
        const profiles = eventCommandProfiles(operation.event);
        if (profiles.some((profile) => offendingPatterns.has(profile))) {
          excludeOperation(operation);
        }
      }
    }

    if (offendingPaths.size > 0) {
      for (const operation of representativeOperations) {
        const pathAliases = eventPathEvidence(operation.event).map((path) =>
          normalizePathAlias(path),
        );
        if (pathAliases.some((alias) => offendingPaths.has(alias))) {
          excludeOperation(operation);
        }
      }
    }

    return {
      violates: false,
      reason: "",
      offendingEventIds: [...offendingEventIds],
      offendingOperationIds: [...offendingOperationIds],
    };
  }

  /**
   * Checks if workflow is trivial (< 2 steps without substantial duration/cost).
   */
  private checkTrivialWorkflow(cluster: WorkflowCluster): TrivialWorkflowCheckResult {
    const avgSteps = cluster.metrics.avgStepCount;
    const avgDuration = cluster.metrics.avgDurationMs;

    // Single step check
    if (avgSteps < this.minMeaningfulSteps) {
      // Check if it's a known trivial command
      for (const cmd of cluster.representativeSignature.commandPatterns) {
        const root = cmd.split(":")[0];
        if (TRIVIAL_COMMANDS[root] === true) {
          return {
            isTrivial: true,
            reason: `Single trivial utility command '${root}'`,
          };
        }
      }

      // If duration is very low (< 3s) and single step, consider trivial
      if (avgDuration < 3000 && cluster.metrics.avgTokens < 500) {
        return {
          isTrivial: true,
          reason: `Workflow consists of only ${avgSteps} steps with minimal execution time (${avgDuration}ms)`,
        };
      }
    }

    return { isTrivial: false, reason: "" };
  }

  /**
   * Checks if workflow is unobservable (empty events or missing causal refs).
   */
  private checkUnobservable(cluster: WorkflowCluster): UnobservableCheckResult {
    if (cluster.evidenceEventIds.length === 0) {
      return {
        isUnobservable: true,
        reason: "Workflow has no associated evidence event IDs.",
      };
    }

    // Verify all episodes have valid timestamps
    for (const ep of cluster.episodes) {
      if (!ep.events || ep.events.length === 0) {
        return {
          isUnobservable: true,
          reason: "Episode contains empty event stream.",
        };
      }
    }

    return { isUnobservable: false, reason: "" };
  }
}

/**
 * Convenience function to evaluate suppression.
 */
export function evaluateSuppression(
  cluster: WorkflowCluster,
  options: SuppressionOptions & {
    envelope?: CapabilityEnvelope;
    recentOpportunityHashes?:
      | Set<string>
      | Map<string, number>
      | Map<string, Date>
      | Map<string, RecentOpportunityHashRecord>;
    now?: number;
  } = {},
): SuppressionResult {
  const engine = new SuppressionEngine(options);
  return engine.evaluateSuppression(cluster, options);
}
