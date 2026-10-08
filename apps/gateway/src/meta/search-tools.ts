import type { CapabilityManifest, ToolParameterSchema } from "@resin/contracts";
import { recordDiscoverySearch } from "@resin/observer/discovery-funnel";
import type { CallToolResult, JsonRpcParams } from "../protocol/types.js";
import { isAutomaticallyRecommended } from "../registry/recommendation.js";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { ToolCallOptions, ToolHandler } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { isToolOfferedHere } from "./repository-scope.js";
import { multiStepBonus, replacesStepsHint } from "./tool-profile.js";

interface CapabilitySummary {
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

/**
 * One tool as a search lists it: what an agent reads to choose it and invoke it. Fields that hold
 * their usual value are left out; tags and capabilities stay filters, not output.
 */
export interface SearchToolsResultItem {
  toolId: string;
  name: string;
  /** Present only when not "active"; a disabled tool reads "disabled". */
  status?: string;
  /** Present only when not "workspace". */
  scope?: string;
  /** Present only for a pinned version; otherwise the listed version is the one invoke_tool runs. */
  version?: string;
  isPinned?: true;
  isDisabled?: true;
  /** The catalog's purpose sentences followed by this machine's recorded program; see {@link shownDescription}. */
  description: string;
  /** The tool's input schema, so a caller can invoke it without a separate schema lookup. */
  inputSchema: ToolParameterSchema | JsonRpcParams;
  score?: number;
  /** How much recorded work the tool replaces ("Replaces 4 recorded steps."), when more than one. */
  replaces?: string;
  /**
   * Present only as `false`: repeated measurements showed this tool costing more than doing the
   * job directly, so Resin no longer names it unprompted. A search is an explicit request, so the
   * tool keeps its rank here and still invokes by name.
   */
  recommended?: false;
  /** Lower-ranked matches running the same set of commands as this tool, listed compactly. */
  similar?: SimilarTool[];
}

/**
 * A match that runs the same commands as the item it is listed under, with its purpose. A close
 * contender (see {@link CLOSE_MATCH_RATIO}) also carries its id, score and input schema, so an
 * agent can invoke the one it picks without another lookup. In measured runs, listing the rest by
 * name alone sent agents through up to 8 get_tool_schema calls to tell them apart, so they keep
 * their purpose.
 */
export interface SimilarTool {
  name: string;
  /** The first sentence of what the tool does, at most {@link PURPOSE_MAX_LENGTH} characters. */
  purpose: string;
  toolId?: string;
  score?: number;
  inputSchema?: ToolParameterSchema | JsonRpcParams;
}

/**
 * A similar tool scoring at least this share of its item's score is a close contender. In
 * measured runs the job's exact tool scored 10.58 under an item scoring 10.61; the agent picked
 * it and spent a request reading its schema.
 */
const CLOSE_MATCH_RATIO = 0.9;

/** At most this many close contenders per item carry a schema; exact duplicates all tie. */
const CLOSE_MATCH_LIMIT = 2;

/**
 * A page of search results. `limit`, `offset`, `total` and `hasMore` count items in `tools`: each
 * item stands for its group of tools running the same commands, so a tool listed under another's
 * `similar` is not counted and never appears on another page.
 */
export interface SearchToolsResponse {
  tools: SearchToolsResultItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /**
   * With no match for a non-empty query, {@link NO_MATCHING_TOOL_NOTE}; with results, what the
   * items leave unsaid once (see {@link resultNote}); otherwise absent.
   */
  note?: string;
}

/** How many tools a search returns when the caller names no `limit`. */
export const DEFAULT_SEARCH_LIMIT = 5;

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
 * The sentence the cloud ends the description of a tool learned from one recording with
 * (`RECORDED_WORKFLOW_PROVISIONAL_NOTE`). A search says once, in its note, what it means for a call.
 */
const PROVISIONAL_SENTENCE = /\s*Learned from [^.;]*; defaults are the recorded values\./gu;
/**
 * Sentences a learned tool's input descriptions repeat for every input (`recordedWorkflowInputSchema`
 * in @resin/runtime). A search drops them and says each once, in its note.
 */
const OMIT_INPUT_SENTENCE = /\s*Omit to use the recorded value\.?/gu;
const LIST_INPUT_SENTENCE =
  /A list of words: each item is passed to the command as one separate argument\.\s*/gu;

const RECORDED_VALUES_NOTE = "Omitted inputs reuse their recorded values.";
const LIST_INPUT_NOTE =
  "Each item of an array input is passed to the command as one separate argument.";
const SIMILAR_NOTE =
  "A tool under `similar` runs the same commands as the item it is listed under; invoke it by name with its inputSchema, or, when none is listed, with the inputs get_tool_schema(name) gives.";

/** The longest `purpose` a similar tool is listed with. */
const PURPOSE_MAX_LENGTH = 140;

/** Which repeated sentences a search dropped from the tools it lists, so its note says each once. */
interface Omissions {
  recordedValues: boolean;
  listInputs: boolean;
}

const SENTENCE_FOLLOWS = /\s+\p{Lu}/uy;

/**
 * The index just past the first sentence of `text`: a `.`, `!` or `?` outside a `code span`,
 * followed by whitespace and a capital letter. Undefined when the text is one sentence.
 */
function firstSentenceEnd(text: string): number | undefined {
  let inCode = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (char !== "." && char !== "!" && char !== "?")) {
      continue;
    }
    SENTENCE_FOLLOWS.lastIndex = index + 1;
    if (SENTENCE_FOLLOWS.test(text)) {
      return index + 1;
    }
  }
  return undefined;
}

/** Words a "Runs …" sentence joins its commands with; they say nothing about what the tool does. */
const COMMAND_LIST_WORDS: ReadonlySet<string> = new Set(searchTokens("runs and then step steps"));

/**
 * The catalog description as a search shows it: without the one-recording sentence, and without a
 * leading "Runs …" sentence whose every word the recorded program shown after it already holds —
 * a list of the commands it runs. A "Runs …" sentence that adds a word ("to verify the caller
 * identity") stays, and so does one that is all the catalog says.
 */
function shownCatalog(catalog: string, local: string | undefined, omissions: Omissions): string {
  const whole = catalog.trim();
  const kept = whole.replace(PROVISIONAL_SENTENCE, "").trim();
  omissions.recordedValues ||= kept !== whole;
  const end = local === undefined || !kept.startsWith("Runs ") ? undefined : firstSentenceEnd(kept);
  if (local === undefined || end === undefined) {
    return kept;
  }
  const recorded = new Set(searchTokens(local));
  const restates = searchTokens(kept.slice(0, end)).every(
    (token) => recorded.has(token) || COMMAND_LIST_WORDS.has(token) || /^\p{N}+$/u.test(token),
  );
  return restates ? kept.slice(end).trim() : kept;
}

/** The first sentence of `text`, on one line and cut to {@link PURPOSE_MAX_LENGTH} characters. */
function purposeOf(text: string): string {
  const end = firstSentenceEnd(text);
  const sentence = (end === undefined ? text : text.slice(0, end)).replace(/\s+/gu, " ").trim();
  const chars = Array.from(sentence);
  return chars.length <= PURPOSE_MAX_LENGTH
    ? sentence
    : `${chars
        .slice(0, PURPOSE_MAX_LENGTH - 1)
        .join("")
        .trimEnd()}…`;
}

/**
 * The input schema with each property's description rewritten by `rewrite`; a description it
 * empties is dropped. Types, items, patterns, enums, `required` and the rest stay.
 */
function rewriteInputDescriptions<T extends object>(
  schema: T,
  rewrite: (description: string) => string,
): T {
  const properties = "properties" in schema ? schema.properties : undefined;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }
  let shown: Record<string, unknown> | undefined;
  for (const [name, property] of Object.entries(properties)) {
    if (property === null || typeof property !== "object" || Array.isArray(property)) {
      continue;
    }
    const description = "description" in property ? property.description : undefined;
    if (typeof description !== "string") {
      continue;
    }
    const kept = rewrite(description);
    if (kept === description) {
      continue;
    }
    shown ??= { ...properties };
    shown[name] =
      kept === ""
        ? Object.fromEntries(Object.entries(property).filter(([key]) => key !== "description"))
        : { ...property, description: kept };
  }
  return shown === undefined ? schema : { ...schema, properties: shown };
}

/** The input schema without the sentences every learned input's description repeats. */
function shownInputSchema<T extends object>(schema: T, omissions: Omissions): T {
  return rewriteInputDescriptions(schema, (description) => {
    const withoutList = description.replace(LIST_INPUT_SENTENCE, "");
    const kept = withoutList.replace(OMIT_INPUT_SENTENCE, "").trim();
    omissions.listInputs ||= withoutList !== description;
    omissions.recordedValues ||= kept !== withoutList.trim();
    return kept;
  });
}

/** The note a page of results carries: each sentence its items dropped, said once. */
function resultNote(
  omissions: Omissions,
  hasSimilar: boolean,
): { note: string } | Record<string, never> {
  const sentences = [
    ...(omissions.recordedValues ? [RECORDED_VALUES_NOTE] : []),
    ...(omissions.listInputs ? [LIST_INPUT_NOTE] : []),
    ...(hasSimilar ? [SIMILAR_NOTE] : []),
  ];
  return sentences.length === 0 ? {} : { note: sentences.join(" ") };
}

/**
 * Summarizes tool capability manifest into a human and agent-readable summary.
 */
function summarizeCapabilities(caps?: CapabilityManifest): CapabilitySummary {
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

/** A tool that passed the filters, with what scoring and listing it read. */
interface SearchCandidate {
  tool: RegistryTool;
  /** The exposed name, else the registered one. */
  name: string;
  isPinned: boolean;
  isDisabled: boolean;
  tags: string[];
  description: ToolDescriptionParts;
  /** The commands a learned tool's recorded programs run; tools running the same set share an item. */
  commands: string[];
  steps: number | undefined;
  /** False when measurements showed the tool costing more than doing the job directly. */
  recommended: boolean;
}

/** A candidate in result order; scored only when the search has a query. */
interface RankedCandidate {
  candidate: SearchCandidate;
  score?: number;
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
    // Every item carries its description and input schema, which the caller reads in full; tools
    // running the same commands share one item. `hasMore` and `offset` page the rest.
    const limit = Math.min(Math.max(Number(params.limit) || DEFAULT_SEARCH_LIMIT, 1), 100);
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
    const filtered: SearchCandidate[] = [];

    for (const { tool, isPinned, isDisabled } of candidateMap.values()) {
      // A learned tool is offered only in its repository, and only where it can run.
      if (!isToolOfferedHere(registry, tool, context)) {
        continue;
      }
      const tags = extractTags(tool);

      // Filter by requested tags
      if (requestedTags.length > 0) {
        const hasAllTags = requestedTags.some((rt) => tags.includes(rt));
        if (!hasAllTags) {
          continue;
        }
      }

      // Filter by requested capabilities
      if (requestedCaps.length > 0) {
        const capTypes = summarizeCapabilities(tool.manifest.capabilities).types.map((t) =>
          t.toLowerCase(),
        );
        if (!requestedCaps.some((rc) => capTypes.includes(rc))) {
          continue;
        }
      }

      filtered.push({
        tool,
        name: tool.exposedName || tool.name,
        isPinned,
        isDisabled,
        tags,
        description: toolDescriptionParts(tool, context, describer),
        commands: tool.isSystem ? [] : registry.learnedToolCommands(tool, context),
        steps: tool.isSystem ? undefined : registry.learnedToolProfile(tool, context)?.steps,
        recommended: isAutomaticallyRecommended(tool),
      });
    }

    const scores = query
      ? scoreToolsForQuery(
          query,
          // The registered name stays searchable when the exposed one is disambiguated.
          filtered.map(({ tool, name, tags, description, commands, steps, isPinned }) => ({
            names: [name, tool.name],
            tags,
            description: description.catalog,
            ...(description.local === undefined ? {} : { recorded: description.local }),
            commands,
            ...(steps === undefined ? {} : { steps }),
            isPinned,
          })),
        )
      : [];
    const scoredTools: RankedCandidate[] = query
      ? filtered.flatMap((candidate, index) => {
          const score = scores[index];
          return score === undefined ? [] : [{ candidate, score }];
        })
      : filtered.map((candidate) => ({ candidate }));

    // By score descending, then name ascending. Measured cost does not reorder a search: it is an
    // explicit request, and pushing the best match down only adds a schema lookup.
    scoredTools.sort(({ candidate: a, score: aScore = 0 }, { candidate: b, score: bScore = 0 }) => {
      if (query) {
        if (bScore !== aScore) {
          return bScore - aScore;
        }
      } else {
        // System tools first, then pinned, then those replacing more recorded work, then by name
        if (a.tool.toolId.startsWith("sys_") && !b.tool.toolId.startsWith("sys_")) return -1;
        if (!a.tool.toolId.startsWith("sys_") && b.tool.toolId.startsWith("sys_")) return 1;
        if (a.isPinned && !b.isPinned) return -1;
        if (!a.isPinned && b.isPinned) return 1;
        if ((a.steps ?? 1) !== (b.steps ?? 1)) return (b.steps ?? 1) - (a.steps ?? 1);
      }
      return a.name.localeCompare(b.name);
    });

    // Tools running the same set of commands are one result: the best-ranked gets a full item and
    // the rest are listed under its `similar`. A tool with no recorded command stands alone.
    const groups: { lead: RankedCandidate; similar: RankedCandidate[] }[] = [];
    const groupByCommands = new Map<string, (typeof groups)[number]>();
    for (const ranked of scoredTools) {
      const commands = ranked.candidate.commands;
      const key = commands.length === 0 ? undefined : [...new Set(commands)].sort().join("\n");
      const group = key === undefined ? undefined : groupByCommands.get(key);
      if (group) {
        group.similar.push(ranked);
        continue;
      }
      const created = { lead: ranked, similar: [] };
      groups.push(created);
      if (key !== undefined) {
        groupByCommands.set(key, created);
      }
    }

    const total = groups.length;
    const omissions: Omissions = { recordedValues: false, listInputs: false };
    const tools = groups.slice(offset, offset + limit).map(({ lead, similar }) => {
      const { tool, name, isPinned, isDisabled, description, steps } = lead.candidate;
      const status = isDisabled ? "disabled" : tool.status || "active";
      const scope = tool.scope ?? "workspace";
      const catalog = shownCatalog(description.catalog, description.local, omissions);
      const replaces = replacesStepsHint(steps);
      const item: SearchToolsResultItem = {
        toolId: tool.toolId,
        name,
        ...(status === "active" ? {} : { status }),
        ...(scope === "workspace" ? {} : { scope }),
        ...(isPinned ? { version: tool.version, isPinned: true as const } : {}),
        ...(isDisabled ? { isDisabled: true as const } : {}),
        description: registry.scrubLearnedToolText(
          tool,
          context,
          joinDescription({ ...description, catalog }),
        ),
        inputSchema: shownInputSchema(
          registry.learnedToolInputSchema(tool, context, toolInputSchema(tool)),
          omissions,
        ),
        ...(lead.score === undefined ? {} : { score: lead.score }),
        ...(replaces === undefined ? {} : { replaces }),
        ...(lead.candidate.recommended ? {} : { recommended: false as const }),
        ...(similar.length === 0
          ? {}
          : {
              similar: similar.map(({ candidate, score }, index): SimilarTool => {
                // `similar` is in rank order, so the first contenders are the closest.
                const close =
                  index < CLOSE_MATCH_LIMIT &&
                  score !== undefined &&
                  lead.score !== undefined &&
                  score >= CLOSE_MATCH_RATIO * lead.score;
                // What the item would show, minus the program: its purpose sentence comes first.
                const shown =
                  shownCatalog(candidate.description.catalog, candidate.description.local, {
                    recordedValues: false,
                    listInputs: false,
                  }) || `Runs ${candidate.commands.join(", ")}.`;
                const purpose = purposeOf(
                  registry.scrubLearnedToolText(candidate.tool, context, shown),
                );
                if (!close) return { name: candidate.name, purpose };
                return {
                  toolId: candidate.tool.toolId,
                  name: candidate.name,
                  purpose,
                  ...(score === undefined ? {} : { score }),
                  inputSchema: shownInputSchema(
                    registry.learnedToolInputSchema(
                      candidate.tool,
                      context,
                      toolInputSchema(candidate.tool),
                    ),
                    omissions,
                  ),
                };
              }),
            }),
      };
      return item;
    });
    // The discovery funnel counts the search and whether it found anything; never the query.
    recordDiscoverySearch(scoredTools.length);

    const response: SearchToolsResponse = {
      tools,
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      ...(total === 0
        ? noMatchingToolNote(query, total)
        : resultNote(
            omissions,
            tools.some((item) => item.similar !== undefined),
          )),
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
