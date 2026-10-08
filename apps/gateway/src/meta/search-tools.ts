import type { CapabilityManifest, ToolParameterSchema } from "@resin/contracts";
import { recordDiscoverySearch } from "@resin/observer/discovery-funnel";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { isToolOfferedHere } from "./repository-scope.js";
import { multiStepBonus, replacesStepsHint } from "./tool-profile.js";

export interface CapabilitySummary {
  types: string[];
  summary: string;
  auditLevel: string;
  network?: {
    allowedHosts: string[];
    allowedPorts?: number[];
    allowAll?: boolean;
  };
  filesystem?: {
    readOnly: boolean;
    allowedPaths: string[];
  };
}

export interface SearchToolsResultItem {
  toolId: string;
  name: string;
  version: string;
  scope: string;
  status: string;
  description: string;
  /** The tool's input schema, so a caller can invoke it without a separate schema lookup. */
  inputSchema: ToolParameterSchema | JsonRpcParams;
  tags: string[];
  capabilities: CapabilitySummary;
  isPinned: boolean;
  isDisabled: boolean;
  score?: number;
  /** How much recorded work the tool replaces ("Replaces 4 recorded steps."), when more than one. */
  replaces?: string;
}

export interface SearchToolsResponse {
  tools: SearchToolsResultItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Present only when a non-empty query matched no tool; see {@link noMatchingToolNote}. */
  note?: string;
}

/**
 * What an agent is told when its query matches no learned tool. An empty result alone read as "this
 * workspace cannot do that": an agent asked for a PostHog error report searched `posthog`, found
 * nothing and answered that no PostHog tools were available instead of doing the task. Learned
 * tools are shortcuts for work the agent can already do, so the note sends it back to that work.
 */
export const NO_MATCHING_TOOL_NOTE =
  "No learned tool matches this query. Do the task yourself with your usual tools; Resin learns from that work.";

/**
 * The note to add to a discovery result: only for a non-empty query that matched no tool. An empty
 * query is a listing, not a question about the task, and a query with results needs no advice.
 */
export function noMatchingToolNote(
  query: string | undefined,
  total: number,
): { note: string } | Record<string, never> {
  return query !== undefined && query.trim() !== "" && total === 0
    ? { note: NO_MATCHING_TOOL_NOTE }
    : {};
}

export interface SearchToolsParams {
  query?: string;
  tags?: string[];
  capabilities?: string[];
  scope?: "session" | "workspace" | "account" | "system" | "global" | "all";
  status?: "active" | "draft" | "deprecated" | "revoked" | "all";
  limit?: number;
  offset?: number;
}

/**
 * Local-only detail about what a tool runs, such as a learned tool's recorded program. It is built
 * on this machine and never uploaded, but it reaches the model: it shows no resolved private value.
 */
export type LocalToolDescriber = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => string | undefined;

/** The input schema a tool is invoked with; a tool without declared inputs takes none. */
export function toolInputSchema(tool: RegistryTool): ToolParameterSchema | JsonRpcParams {
  return (
    tool.parameters ??
    tool.manifest?.parameters ?? {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    }
  );
}

/** A tool's catalog description and the detail this machine adds to it, kept apart. */
interface ToolDescriptionParts {
  catalog: string;
  /** A learned tool's recorded program, as the {@link LocalToolDescriber} renders it. */
  local?: string;
}

function toolDescriptionParts(
  tool: Pick<RegistryTool, "artifactDigest" | "description" | "manifest">,
  context: WorkspaceContext,
  describer?: LocalToolDescriber,
): ToolDescriptionParts {
  const catalog = tool.description || tool.manifest?.description || "";
  const local = describer?.(tool, context);
  return local ? { catalog, local } : { catalog };
}

function joinDescription({ catalog, local }: ToolDescriptionParts): string {
  return local ? (catalog ? `${catalog}\n\n${local}` : local) : catalog;
}

/** The description an agent sees: the catalog's, followed by any local detail. */
export function describeToolLocally(
  tool: Pick<RegistryTool, "artifactDigest" | "description" | "manifest">,
  context: WorkspaceContext,
  describer?: LocalToolDescriber,
): string {
  return joinDescription(toolDescriptionParts(tool, context, describer));
}

/**
 * Summarizes tool capability manifest into a human and agent-readable summary.
 */
export function summarizeCapabilities(caps?: CapabilityManifest): CapabilitySummary {
  if (!caps) {
    return {
      types: ["none"],
      summary: "No external capabilities required (pure compute)",
      auditLevel: "standard",
    };
  }

  const detectedTypes: string[] = [];
  const summaryParts: string[] = [];

  let networkInfo: CapabilitySummary["network"] | undefined;
  if (caps.net) {
    const net = caps.net;
    const hosts = [...(net.allowedHosts ?? []), ...(net.allowedDomains ?? [])];
    const hasNet = Boolean(net.allowOutbound || hosts.length > 0);
    if (hasNet) {
      detectedTypes.push("network");
      networkInfo = {
        allowedHosts: hosts,
        allowedPorts: net.allowedPorts,
        allowAll: Boolean(net.allowOutbound && hosts.length === 0),
      };
      if (hosts.length > 0) {
        summaryParts.push(`Network (${hosts.join(", ")})`);
      } else {
        summaryParts.push("Network (outbound)");
      }
    }
  }

  let filesystemInfo: CapabilitySummary["filesystem"] | undefined;
  if (caps.fs) {
    const fs = caps.fs;
    const paths = Array.from(new Set([...(fs.readPaths ?? []), ...(fs.writePaths ?? [])]));
    const hasFs =
      paths.length > 0 || (fs.allowTemp && (fs.readPaths?.length || fs.writePaths?.length));
    if (hasFs || paths.length > 0) {
      detectedTypes.push("filesystem");
      const isReadOnly = (fs.writePaths?.length ?? 0) === 0;
      filesystemInfo = {
        readOnly: isReadOnly,
        allowedPaths: paths,
      };
      const mode = isReadOnly ? "read-only" : "read-write";
      if (paths.length > 0) {
        summaryParts.push(`Filesystem (${mode}: ${paths.join(", ")})`);
      } else {
        summaryParts.push(`Filesystem (${mode})`);
      }
    }
  }

  if (caps.command) {
    const cmd = caps.command;
    const cmds = [...(cmd.allowedCommands ?? []), ...(cmd.allowedBinaries ?? [])];
    if (cmd.allowShellExecution || cmds.length > 0) {
      detectedTypes.push("shell");
      summaryParts.push("Shell execution");
    }
  }

  if (caps.secrets) {
    const sec = caps.secrets;
    const names = [...(sec.allowedSecretNames ?? []), ...(sec.allowedPrefixes ?? [])];
    if (names.length > 0) {
      detectedTypes.push("secrets");
      summaryParts.push(`Secrets access (${names.join(", ")})`);
    }
  }

  if (detectedTypes.length === 0) {
    detectedTypes.push("builtin");
    summaryParts.push("Builtin capability / pure compute");
  }

  return {
    types: detectedTypes,
    summary: summaryParts.join("; "),
    auditLevel: "standard",
    network: networkInfo,
    filesystem: filesystemInfo,
  };
}

/**
 * Extracts all searchable tags from a tool.
 */
function extractTags(tool: RegistryTool): string[] {
  const tags = new Set<string>();

  const meta =
    tool.manifest.metadata && tool.manifest.metadata instanceof Object
      ? tool.manifest.metadata
      : undefined;
  if (meta && "tags" in meta && Array.isArray(meta.tags)) {
    for (const t of meta.tags) {
      if (t && Object.prototype.toString.call(t) === "[object String]" && String(t).trim()) {
        tags.add(String(t).trim().toLowerCase());
      }
    }
  }

  const capSummary = summarizeCapabilities(tool.manifest.capabilities);
  for (const t of capSummary.types) {
    tags.add(t.toLowerCase());
  }

  return Array.from(tags);
}

/**
 * Checks whether a tool is visible within the caller's context scope.
 */
export function isToolInScope(tool: RegistryTool, context: WorkspaceContext): boolean {
  const toolScope = tool.scope ?? "workspace";

  // System or global tools are visible everywhere
  if (toolScope === "system" || toolScope === "global" || tool.isSystem) {
    return true;
  }

  // Session-scoped tools: must match workspace and session
  if (toolScope === "session" || tool.sessionId) {
    if (!context.sessionId || tool.sessionId !== context.sessionId) {
      return false;
    }
    if (tool.workspaceId && context.workspaceId && tool.workspaceId !== context.workspaceId) {
      return false;
    }
    return true;
  }

  // Workspace-scoped tools (default): must match workspace
  if (tool.workspaceId) {
    return tool.workspaceId === context.workspaceId;
  }

  return false;
}

/** Lowercases text and splits it into whole words, folding a plural `s` so `tests` finds `test`. */
function searchTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((token) =>
      token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token,
    );
}

/** Whether `needle` occurs as a contiguous run of `haystack`. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((token, i) => haystack[start + i] === token)) {
      return true;
    }
  }
  return false;
}

/** A shell word naming an option: `-o`, `--profile`, `--group-by=…`; not a dash in prose. */
const OPTION_WORD = /^--?[\p{L}\p{N}]/u;
/** Shell words that end one command, so the word after one is never an option's value. */
const SHELL_OPERATORS: ReadonlySet<string> = new Set(["&&", "||", "|", ";", "&", ">", ">>", "<"]);
/** A `{name}` hole a learned tool fills from its inputs: a parameter name, not a recorded value. */
const PARAMETER_HOLE = /^\{[^{}]+\}\W*$/u;

/**
 * The text without the argument values a recorded run happened to pass: an option's value
 * (`--profile acme-production-auto`, `--group-by Type=DIMENSION,Key=SERVICE`), the right side of a
 * `key=value` word, and the value after a standalone `=` (`profile = acme-production-auto`).
 *
 * Those values are the data of one run — profile and alarm names, ids, dates — not what the tool
 * does, and their parts are ordinary words: `acme-production-auto` made every tool recorded with
 * that profile match a question about the `acme` daemon, and `Key=SERVICE` one about services.
 * Commands, subcommands, option names, `{name}` holes and prose all stay. Values are found one
 * whitespace-separated word at a time, so a quoted value with spaces loses only its first word.
 */
function withoutRecordedValues(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const kept: string[] = [];
      let valueFollows = false;
      for (const word of line.split(/\s+/).filter(Boolean)) {
        const isValue =
          valueFollows &&
          !OPTION_WORD.test(word) &&
          !SHELL_OPERATORS.has(word) &&
          !PARAMETER_HOLE.test(word);
        valueFollows = false;
        if (isValue) {
          continue;
        }
        if (word === "=") {
          valueFollows = true;
          continue;
        }
        const assignment = word.indexOf("=");
        if (assignment > 0) {
          kept.push(word.slice(0, assignment));
          continue;
        }
        kept.push(word);
        // An option closing a code span or a sentence (`--watch\``, `--watch.`) takes no value.
        valueFollows = OPTION_WORD.test(word) && !/[`.,;:)]$/u.test(word);
      }
      return kept.join(" ");
    })
    .join("\n");
}

/**
 * Lines Resin writes around the programs in a learned tool's local detail (`RecordedWorkflowSummary`
 * in proxy/local-executor.ts): the "Recorded on this machine:" header, the "Step N runs this
 * recorded shell program:" heads, elision markers, and the parameter listings, which hold nothing
 * but recorded values.
 */
const RECORDED_DETAIL_FRAMING =
  /^(?:Recorded on this machine:|Step \d+\b|\[(?:\.\.\.|\d+ more steps? not shown)\]$|(?:Required )?[Pp]arameters \()/u;
/** The file an edit step's head names (`Step 2 edits src/app.ts, adding:`). */
const EDITED_FILE = /^Step \d+\b.*? edits (\S+?)(?:,| \(|$)/u;

/**
 * The recorded programs in a learned tool's local detail, without Resin's framing around them:
 * the framing is the same for every learned tool ("Recorded on this machine" made each one match
 * a question about "this machine"), so only the programs, and the files edit steps edit, say what
 * this tool does.
 */
function recordedPrograms(local: string): string {
  return local
    .split("\n")
    .flatMap((line) => {
      if (!RECORDED_DETAIL_FRAMING.test(line)) {
        return [line];
      }
      const edited = EDITED_FILE.exec(line)?.[1];
      return edited === undefined ? [] : [edited];
    })
    .join("\n");
}

/** The text of one candidate tool that a query is matched against. */
interface SearchableTool {
  /** Exposed and registered names. */
  names: string[];
  tags: string[];
  /** The catalog description. */
  description: string;
  /** A learned tool's local recorded program, which the agent sees after the description. */
  recorded?: string;
  /** The commands the tool's recorded programs run on this machine (`vitest`, `gh pr checks`). */
  commands?: readonly string[];
  /** Recorded steps the tool replays, when known: more recorded work ranks higher. */
  steps?: number;
  isPinned: boolean;
}

// A query word counts more in a tool's name than in its tags, and more there than in its description.
const NAME_WEIGHT = 2;
const TAG_WEIGHT = 1.5;
const DESCRIPTION_WEIGHT = 1;
// Bonuses for searching by a tool's name; they outrank any word match (worth at most LEXICAL_SCALE).
const EXACT_NAME_BONUS = 100;
const NAME_PREFIX_BONUS = 60;
const NAME_PHRASE_BONUS = 35;
const LEXICAL_SCALE = 20;
const PINNED_BONUS = 5;
// A word in more than half the candidates (and in more than this many) cannot by itself make a tool
// match: learned tools share boilerplate ("Runs ...", "recorded shell program", the `shell` tag).
const UBIQUITOUS_MIN_TOOLS = 5;
// A tool covering less than this share of the query weight the best tool covers is dropped as noise
// (so its Lucene-style coverage-squared relevance stays above ~35% of the best).
const RELATIVE_COVERAGE_FLOOR = 0.6;
// Unless a query word names the tool or a command it runs, a tool must cover at least this share of
// the query's subject, counting each subject word no tool contains as rarer than any that some tool
// does: a question about one service's errors must not return every tool whose text says "errors".
const ABSOLUTE_COVERAGE_FLOOR = 0.5;

/**
 * Words a task description is phrased with rather than words naming what a tool does: function
 * words, request verbs ("list", "identify", "compare", "review"), report shapes ("breakdown",
 * "summary") and time frames ("current", "last", "hours", "today"). Learned tool descriptions use
 * them too ("steps 1 and 5", "24 hours ago"), so in a small catalog, where no word is common
 * enough to be dismissed as ubiquitous, one of them alone matched an unrelated tool: a PostHog
 * question found the AWS cost tool through "hours". They still weigh in a tool's ranking; they
 * just never make a tool match on their own. Folded like query words, so plurals are covered.
 */
const GENERIC_QUERY_WORDS: ReadonlySet<string> = new Set(
  searchTokens(
    [
      // Function words.
      "a an the and or but nor not no of to in on at by for from with without into onto over",
      "under about as is are was were be been being am it its this that these those there here",
      "then than so if else via per vs versus up down out off again also too very just only own",
      "same such both each every either any all some many much more most less least few other",
      "between after before during since until while plus what which who whom whose when where",
      "whether",
      "why how i me my we our us you your he she they them their his her can could will would",
      "should shall may might must do does did done doing have has had having get got please",
      // Request verbs and the shapes of an answer.
      "list show give find look see check tell make let want need help try use using used run",
      "running ran",
      "identify compare review investigate inspect examine analyze analyse explore determine",
      "summarize summarise summary report overview breakdown detail info information result",
      "count number total top new old",
      // Time frames.
      "current currently now today yesterday tomorrow recent recently latest last past previous",
      "next ago time period second minute hour day week month year daily weekly monthly yearly",
    ].join(" "),
  ),
);

/** Whether a query word only frames the task, so it cannot by itself make a tool match. */
function isGenericQueryWord(token: string): boolean {
  // A bare number is a count or a duration ("last 36 hours"), not something a tool does.
  return GENERIC_QUERY_WORDS.has(token) || /^\p{N}+$/u.test(token);
}

/**
 * Scores each tool against the query, or returns undefined for a tool that does not match.
 *
 * Query words are weighted by inverse document frequency over the candidates, so a word nearly every
 * tool contains contributes almost nothing and a distinctive one (`pnpm`, `gh`) decides the ranking.
 * A tool's word score is scaled by the share of the query's weight it covers, so tools matching the
 * whole command outrank tools matching one common word of it. Searching by name earns a bonus.
 * Otherwise a tool matches only through a distinctive word: neither one most tools share nor one
 * that merely frames the task (see {@link GENERIC_QUERY_WORDS}), found in the tool's name, tags,
 * description or recorded programs — not only in a recorded argument value or Resin's framing
 * around those programs (see {@link withoutRecordedValues} and {@link recordedPrograms}).
 */
function scoreToolsForQuery(
  query: string,
  tools: readonly SearchableTool[],
): (number | undefined)[] {
  const queryTokens = [...new Set(searchTokens(query))];
  const documents = tools.map((tool) => {
    const nameSequences = tool.names.map(searchTokens);
    const name = new Set(nameSequences.flat());
    const tags = new Set(tool.tags.flatMap(searchTokens));
    const commands = (tool.commands ?? []).flatMap(searchTokens);
    const description = new Set([
      ...searchTokens(tool.description),
      ...searchTokens(tool.recorded ?? ""),
      ...commands,
    ]);
    // The words that can make this tool match; the rest of its text only ranks it.
    const qualifying = new Set([
      ...name,
      ...tags,
      ...commands,
      ...searchTokens(withoutRecordedValues(tool.description)),
      ...searchTokens(withoutRecordedValues(recordedPrograms(tool.recorded ?? ""))),
    ]);
    // Words naming the tool itself or a command it runs: one of them alone is a clear match.
    const strong = new Set([...name, ...commands]);
    return { nameSequences, name, tags, description, qualifying, strong };
  });

  const total = documents.length;
  const idf = new Map<string, number>();
  const informative = new Set<string>();
  // Subject words no candidate contains weigh as more specific than any word one does.
  let unknownSubjectWeight = 0;
  for (const token of queryTokens) {
    const frequency = documents.filter(
      (doc) => doc.name.has(token) || doc.tags.has(token) || doc.description.has(token),
    ).length;
    if (frequency === 0) {
      if (total > 0 && !isGenericQueryWord(token)) {
        unknownSubjectWeight += Math.log(1 + (total + 0.5) / 0.5);
      }
      continue;
    }
    idf.set(token, Math.log(1 + (total - frequency + 0.5) / (frequency + 0.5)));
    const distinctive = frequency <= total / 2 || frequency <= UBIQUITOUS_MIN_TOOLS;
    if (distinctive && !isGenericQueryWord(token)) {
      informative.add(token);
    }
  }
  const queryWeight = [...idf.values()].reduce((sum, weight) => sum + weight, 0);
  // Whether a tool covers enough of the query is judged on the words naming the task's subject: a
  // framing word one tool happens to share ("daily") must not push an equally relevant tool out.
  const subjectWeight = [...idf].reduce(
    (sum, [token, weight]) => (isGenericQueryWord(token) ? sum : sum + weight),
    0,
  );

  const scored = tools.map((tool, index) => {
    const doc = documents[index];
    if (!doc) {
      return undefined;
    }
    const startsWithQuery = (seq: string[]) =>
      queryTokens.length > 0 && queryTokens.every((token, i) => seq[i] === token);
    const exact =
      tool.names.some((name) => name.toLowerCase() === query) ||
      doc.nameSequences.some((seq) => seq.length === queryTokens.length && startsWithQuery(seq));
    const prefix =
      !exact &&
      (tool.names.some((name) => name.toLowerCase().startsWith(query)) ||
        doc.nameSequences.some(startsWithQuery));
    const phrase =
      queryTokens.length > 0 && doc.nameSequences.some((seq) => containsSequence(seq, queryTokens));

    let matchedWeight = 0;
    let subjectMatched = 0;
    let fieldWeighted = 0;
    let matchesInformative = false;
    let matchesStrong = false;
    for (const [token, weight] of idf) {
      const fieldWeight = doc.name.has(token)
        ? NAME_WEIGHT
        : doc.tags.has(token)
          ? TAG_WEIGHT
          : doc.description.has(token)
            ? DESCRIPTION_WEIGHT
            : 0;
      if (fieldWeight === 0) {
        continue;
      }
      matchedWeight += weight;
      subjectMatched += isGenericQueryWord(token) ? 0 : weight;
      fieldWeighted += weight * fieldWeight;
      matchesInformative ||= informative.has(token) && doc.qualifying.has(token);
      matchesStrong ||= informative.has(token) && doc.strong.has(token);
    }
    const coverage = queryWeight > 0 ? matchedWeight / queryWeight : 0;
    const subjectCoverage = subjectWeight > 0 ? subjectMatched / subjectWeight : 0;
    const wholeSubject = subjectWeight + unknownSubjectWeight;
    const absoluteCoverage = wholeSubject > 0 ? subjectMatched / wholeSubject : 0;
    const lexical =
      queryWeight > 0
        ? (LEXICAL_SCALE * fieldWeighted * coverage) / (NAME_WEIGHT * queryWeight)
        : 0;
    const bonus = exact
      ? EXACT_NAME_BONUS
      : prefix
        ? NAME_PREFIX_BONUS
        : phrase
          ? NAME_PHRASE_BONUS
          : 0;
    return {
      lexical,
      bonus,
      subjectCoverage,
      alwaysMatches: exact || prefix,
      matchesInformative,
      clearMatch: matchesStrong || absoluteCoverage >= ABSOLUTE_COVERAGE_FLOOR,
    };
  });

  const bestCoverage = Math.max(
    0,
    ...scored.map((s) => (s?.matchesInformative && s.clearMatch ? s.subjectCoverage : 0)),
  );
  return scored.map((s, index) => {
    if (!s) {
      return undefined;
    }
    const relevant =
      s.matchesInformative &&
      s.clearMatch &&
      s.subjectCoverage >= RELATIVE_COVERAGE_FLOOR * bestCoverage;
    if (!s.alwaysMatches && !relevant) {
      return undefined;
    }
    const tool = tools[index];
    const score =
      s.bonus +
      s.lexical +
      (tool?.isPinned ? PINNED_BONUS : 0) +
      // More recorded work replaced ranks higher among similarly relevant tools.
      multiStepBonus(tool?.steps);
    return Math.round(score * 100) / 100;
  });
}

/**
 * Factory for creating the search_tools handler.
 */
export function createSearchToolsHandler(
  registry: ToolRegistry,
  describer?: LocalToolDescriber,
): ToolHandler {
  return async (
    context: WorkspaceContext,
    params: JsonRpcParams,
    _options?: ToolCallOptions,
  ): Promise<CallToolResult> => {
    const query =
      params.query && Object.prototype.toString.call(params.query) === "[object String]"
        ? String(params.query).trim().toLowerCase()
        : "";
    const requestedTags = Array.isArray(params.tags)
      ? params.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
      : [];
    const requestedCaps = Array.isArray(params.capabilities)
      ? params.capabilities.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    const requestedScope = params.scope;
    const requestedStatus = params.status ?? "active";
    const limit = Math.min(Math.max(Number(params.limit) || 20, 1), 100);
    const offset = Math.max(Number(params.offset) || 0, 0);

    // Retrieve caller's user controls
    const controls = await registry.controls.getControls(context.workspaceId);
    // The version each tool resolves to when invoked: the registry keeps every version this process
    // registered, oldest first, so a version synced after startup would otherwise lose to its
    // predecessor here while get_tool_schema and invoke_tool run the new one.
    const activeVersions = (await registry.resolveCatalog(context.workspaceId, context.sessionId))
      .tools;

    // Collect all registered tools and filter to caller's scoped tools
    const allRegistered = registry.getAllRegisteredTools();
    const candidateMap = new Map<
      string,
      { tool: RegistryTool; isPinned: boolean; isDisabled: boolean }
    >();

    for (const tool of allRegistered) {
      // Check scope visibility strictly
      if (!isToolInScope(tool, context)) {
        continue;
      }
      // The meta-tools are always exposed directly; searching lists them only when asked for.
      if (tool.isSystem && requestedScope !== "system") {
        continue;
      }

      const isPinned = controls.pinnedVersions[tool.toolId] === tool.version;
      const isDisabled = controls.disabledTools.includes(tool.toolId) && !tool.isSystem;

      // Filter by status
      if (requestedStatus !== "all") {
        if (requestedStatus === "active" && isDisabled) {
          continue;
        }
        if (tool.status !== requestedStatus && requestedStatus !== "active") {
          continue;
        }
      }

      // Filter by scope
      if (requestedScope && requestedScope !== "all") {
        const toolScope = tool.scope ?? "workspace";
        if (toolScope !== requestedScope) {
          if (
            requestedScope === "system" &&
            !tool.isSystem &&
            toolScope !== "system" &&
            toolScope !== "global"
          ) {
            continue;
          }
          if (requestedScope !== "system" && toolScope !== requestedScope) {
            continue;
          }
        }
      }

      // Only pick the pinned, else the active, version per toolId for search listing
      const existing = candidateMap.get(tool.toolId);
      const isActive = activeVersions[tool.toolId]?.version === tool.version;
      if (!existing || isPinned || (isActive && !existing.isPinned)) {
        candidateMap.set(tool.toolId, { tool, isPinned, isDisabled });
      }
    }

    // Filter, then score against the tools that remain: word weights depend on the whole set.
    // The registered name stays searchable when the exposed one is disambiguated.
    const filtered: {
      item: SearchToolsResultItem;
      registeredName: string;
      description: ToolDescriptionParts;
      commands: string[];
      steps: number | undefined;
    }[] = [];

    for (const { tool, isPinned, isDisabled } of candidateMap.values()) {
      // A learned tool is offered only in its repository, and only where it can run.
      if (!isToolOfferedHere(registry, tool, context)) {
        continue;
      }
      const tags = extractTags(tool);
      const capSummary = summarizeCapabilities(tool.manifest.capabilities);

      // Filter by requested tags
      if (requestedTags.length > 0) {
        const hasAllTags = requestedTags.some((rt) => tags.includes(rt));
        if (!hasAllTags) {
          continue;
        }
      }

      // Filter by requested capabilities
      if (requestedCaps.length > 0) {
        const hasCap = requestedCaps.some((rc) =>
          capSummary.types.map((t) => t.toLowerCase()).includes(rc),
        );
        if (!hasCap) {
          continue;
        }
      }

      const description = toolDescriptionParts(tool, context, describer);
      const steps = tool.isSystem ? undefined : registry.learnedToolProfile(tool, context)?.steps;
      const replaces = replacesStepsHint(steps);
      filtered.push({
        registeredName: tool.name,
        description,
        commands: tool.isSystem ? [] : registry.learnedToolCommands(tool, context),
        steps,
        item: {
          toolId: tool.toolId,
          name: tool.exposedName || tool.name,
          version: tool.version,
          scope: tool.scope ?? "workspace",
          status: isDisabled ? "disabled" : tool.status || "active",
          description: registry.scrubLearnedToolText(tool, context, joinDescription(description)),
          inputSchema: registry.learnedToolInputSchema(tool, context, toolInputSchema(tool)),
          tags,
          capabilities: capSummary,
          isPinned,
          isDisabled,
          score: undefined,
          ...(replaces === undefined ? {} : { replaces }),
        },
      });
    }

    const scores = query
      ? scoreToolsForQuery(
          query,
          filtered.map(({ item, registeredName, description, commands, steps }) => ({
            names: [item.name, registeredName],
            tags: item.tags,
            description: description.catalog,
            ...(description.local === undefined ? {} : { recorded: description.local }),
            commands,
            ...(steps === undefined ? {} : { steps }),
            isPinned: item.isPinned,
          })),
        )
      : [];
    const scoredTools = query
      ? filtered.flatMap(({ item, steps }, index) => {
          const score = scores[index];
          return score === undefined
            ? []
            : [{ item: { ...item, score }, score, steps: steps ?? 1 }];
        })
      : filtered.map(({ item, steps }) => ({ item, score: 0, steps: steps ?? 1 }));

    // Sort by score descending, then name ascending
    scoredTools.sort((a, b) => {
      if (query) {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
      } else {
        // System tools first, then pinned, then those replacing more recorded work, then by name
        if (a.item.toolId.startsWith("sys_") && !b.item.toolId.startsWith("sys_")) return -1;
        if (!a.item.toolId.startsWith("sys_") && b.item.toolId.startsWith("sys_")) return 1;
        if (a.item.isPinned && !b.item.isPinned) return -1;
        if (!a.item.isPinned && b.item.isPinned) return 1;
        if (a.steps !== b.steps) return b.steps - a.steps;
      }
      return a.item.name.localeCompare(b.item.name);
    });

    const total = scoredTools.length;
    const paginated = scoredTools.slice(offset, offset + limit).map((s) => s.item);
    const hasMore = offset + limit < total;
    // The discovery funnel counts the search and whether it found anything; never the query.
    recordDiscoverySearch(total);

    const response: SearchToolsResponse = {
      tools: paginated,
      total,
      limit,
      offset,
      hasMore,
      ...noMatchingToolNote(query, total),
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response),
        },
      ],
    };
  };
}
