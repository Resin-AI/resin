/**
 * The surface a search-listing connection (`resin mcp` without `--full-catalog`) serves: the MCP
 * server instructions and the tools its tools/list shows. Every request a harness makes carries
 * all of it, so it is kept to what the workspace's own learned tools need, and bounded:
 *
 * - Only learned tools scoped to the caller's repository are listed, counted or named (see
 *   `isToolScopedHere`). Others stay searchable and invocable by name.
 * - With none, the server lists only invoke_tool, for a Resin tool the user names, and one line of
 *   instructions: there is nothing to search for.
 * - The relevant tools are listed directly, as tools of their own, in a deterministic order (pinned
 *   first, then those replacing the most recorded work, then by name) for as long as the whole
 *   surface stays within {@link LISTING_CAP}. search_tools is listed only when some are left out,
 *   for those; the instructions say how many and which commands they run.
 *
 * The gateway chooses the listing from the catalog; the stdio shim serves it with the same
 * functions, so the cap holds for exactly what is served.
 */

import { type ListingToolDefinition, listingTextTokens, listingToolTokens } from "@resin/contracts";
import { summarizeLearnedCommands } from "./meta/learned-commands.js";
import { RESIN_LEARNED_TOOL_META } from "./protocol/types.js";
import type { CatalogNoticeTool } from "./router.js";

/**
 * The most a search-listing surface may cost: at most this many learned tools listed directly,
 * and at most this many estimated tokens (UTF-8 bytes / 4) for its instructions and every tool
 * definition it lists together. The measured search-only surface this replaced (instructions,
 * four meta tools) served about 1,900 such tokens on every request in every workspace, unscoped
 * tools included; this lets a workspace's own tools replace search at a lower standing cost. A
 * listed tool's definition and instruction line cost about 100-200 tokens, so eight tools fit
 * when their definitions are short and fewer when they are long.
 */
export const LISTING_CAP = { maxTools: 8, maxTokens: 1_500 } as const;

/** A learned tool as a direct listing names it: its name, call signature and one-line purpose. */
export interface ListedLearnedTool {
  name: string;
  /** The arguments to call it with: `{}` without inputs, else `{name: type, optional?: type}`. */
  signature?: string;
  description?: string;
}

/** A workspace's learned tools as the gateway reports them to a search-listing connection. */
export interface LearnedToolListing {
  /** Learned tools scoped to the caller's repository and recommended. */
  count: number;
  /** The commands those left out of `listing` run, most widely covered first. */
  commands: string[];
  /** The tools listed directly, in listing order; fewer than `count` when the cap left some out. */
  listing: ListedLearnedTool[];
}

/**
 * How any Resin tool may be used, whichever discovery the connection offers: only for exactly the
 * user's task, verified by its actual effects, and never by changing tool state. Kept short because
 * code-mode harnesses repeat a server's instructions in every tool description they list.
 */
const GATEWAY_USE_RULES =
  "Use a tool only for exactly the user's task, honoring their tool choices; check its errors and effects, and never enable, pin, disable or roll back tools.";

/**
 * How learned tools are used. With the discovery route after it, this first line stays within the
 * 250 characters Codex keeps of a deferred tool source's summary.
 */
const LEARNED_TOOL_GUIDANCE =
  "Learned tools rerun recorded work: call one directly when it is your next step; omitted inputs reuse recorded values.";

/** Initialization instructions the gateway returns; a search-listing shim replaces them. */
export const DEFAULT_GATEWAY_INSTRUCTIONS = `${LEARNED_TOOL_GUIDANCE} Else: search_tools(query=<command>) and invoke_tool a result directly, or manage_tools(action=list_versions,scope=workspace).\n${GATEWAY_USE_RULES}`;

/** Initialization instructions for a connection whose tool search is disabled: discovery uses manage_tools. */
export const DISABLED_SEARCH_GATEWAY_INSTRUCTIONS = `${LEARNED_TOOL_GUIDANCE} Else: manage_tools(action=list_versions,scope=workspace,compact=true,query=<keyword>); get_tool_schema(name): steps; invoke_tool.\n${GATEWAY_USE_RULES}`;

/**
 * How a connection runs what search_tools found: each result, including those under `similar`,
 * already carries the tool's recorded steps and its inputSchema, so the next call is invoke_tool,
 * and a tool found earlier in the session is invoked again without another search.
 */
const INVOKE_FROM_SEARCH =
  "Each result is directly invocable: call invoke_tool(name, parameters) with its inputSchema; omitted inputs reuse recorded values. Invoke a tool you already found again without searching; search again only if invoke_tool rejects it.";

/**
 * What a learned tool's output holds. An agent passed over an exact match because its recorded
 * program ended in `| tail -3`, and ran the commands itself; the tool reports what that hid.
 */
const USE_TOOL_OUTPUT =
  "Its output gives each command's exit status when one fails and the diagnostics its recorded `tail`/`head`/`grep` filters hid, so use it instead of rerunning the commands.";

/**
 * invoke_tool as a search-listing connection lists it: what it runs and the two inputs a call
 * needs. The handler still accepts its other inputs (`toolId`, `version`, aliases); listing them
 * only costs every request.
 */
const INVOKE_TOOL_LISTING = {
  description:
    "Runs a Resin learned tool by name, with parameters matching its inputSchema; omitted inputs reuse recorded values.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, parameters: { type: "object" } },
    required: ["name"],
    additionalProperties: true,
  },
};

/** The instructions of a workspace without relevant learned tools: nothing to search for. */
const NO_LEARNED_TOOLS_INSTRUCTIONS =
  "Resin has no learned tools for this workspace, so do the task directly. Call invoke_tool(name) only for a Resin tool the user names, for exactly their task; check its errors and effects, and never enable, pin, disable or roll back tools.";

/** The longest purpose a direct listing's instructions give one tool. */
const DIRECT_LISTING_PURPOSE_CHARS = 140;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const quoted = (commands: readonly string[]) =>
  commands.map((command) => `\`${command}\``).join(", ");

/** The learned tools a direct listing leaves to search, or none when every relevant tool is listed. */
function unlistedCount(learned: LearnedToolListing): number {
  return Math.max(0, learned.count - learned.listing.length);
}

/**
 * The first sentence of search_tools' description: how many learned tools are left out of the
 * listing and which commands they run. Harnesses that ignore server instructions still show tool
 * descriptions, so this is the one channel every harness gets.
 */
function searchSentence(learned: LearnedToolListing): string {
  const more = unlistedCount(learned);
  const tools =
    learned.listing.length === 0
      ? `Resin has ${plural(more, "learned tool")} for this workspace`
      : `Resin has ${plural(more, "more learned tool")} for this workspace than it lists`;
  return `${tools}: search them only when the next command you are about to run is one of theirs (${quoted(learned.commands)}), and call invoke_tool directly with a tool an earlier search found.`;
}

/**
 * Initialization instructions for a search-listing connection. `learned` is undefined while the
 * workspace's catalog is unknown: search is offered, its description names the commands once known.
 */
export function searchListingInstructions(learned: LearnedToolListing | undefined): string {
  if (learned === undefined) {
    return `Resin may have learned tools for this workspace, not listed; search_tools' description names the commands they run. Call search_tools(query=<the command line you are about to run>) only when your next command is one of those. ${INVOKE_FROM_SEARCH} ${USE_TOOL_OUTPUT}\n${GATEWAY_USE_RULES}`;
  }
  if (learned.count === 0) return NO_LEARNED_TOOLS_INSTRUCTIONS;
  const parts: string[] = [];
  if (learned.listing.length > 0) {
    const lines = learned.listing.map((tool) => {
      const line = (tool.description ?? "").trim().split("\n")[0]?.trim() ?? "";
      const purpose =
        line.length > DIRECT_LISTING_PURPOSE_CHARS
          ? `${line.slice(0, DIRECT_LISTING_PURPOSE_CHARS - 1).trimEnd()}…`
          : line;
      const call = tool.signature === undefined ? tool.name : `${tool.name}(${tool.signature})`;
      return purpose === "" ? `- ${call}` : `- ${call}: ${purpose}`;
    });
    parts.push(
      `Resin's learned tools for this workspace, each listed as a tool of its own; call one directly when it is your next step with the arguments shown, without reading its docs first (omitted \`?\` inputs reuse recorded values):\n${lines.join("\n")}`,
    );
  }
  const more = unlistedCount(learned);
  if (more > 0) {
    const tools =
      learned.listing.length === 0
        ? `Resin has ${plural(more, "learned tool")} for this workspace, not listed`
        : `${plural(more, "more learned tool")}, not listed`;
    parts.push(
      learned.commands.length === 0
        ? `${tools}, none running a command Resin can name, so do not search for them.`
        : `${tools}; they run ${quoted(learned.commands)}. Call search_tools(query=<the command line you are about to run>) only when your next command is one of those; otherwise do not search. ${INVOKE_FROM_SEARCH} ${USE_TOOL_OUTPUT}`,
    );
  }
  parts.push(GATEWAY_USE_RULES);
  return parts.join("\n");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The tools a search-listing connection serves out of the catalog's tools/list: invoke_tool always
 * (a learned tool the user names is run by name), search_tools only while there is something to
 * search for, and the learned tools the listing names. Order follows the catalog.
 */
export function searchListingTools(
  tools: readonly unknown[],
  learned: LearnedToolListing | undefined,
): Record<string, unknown>[] {
  const listedNames = new Set(learned?.listing.map((tool) => tool.name));
  // search_tools is offered while the catalog is unknown, or for unlisted tools it can name.
  const search =
    learned === undefined || (unlistedCount(learned) > 0 && learned.commands.length > 0);
  return tools.flatMap((tool): Record<string, unknown>[] => {
    const entry = record(tool);
    if (entry === undefined || typeof entry.name !== "string") return [];
    const name = entry.name;
    if (name === "invoke_tool") return [{ ...entry, ...INVOKE_TOOL_LISTING }];
    if (name === "search_tools") {
      if (!search) return [];
      if (learned === undefined) return [entry];
      const description = typeof entry.description === "string" ? entry.description : "";
      const sentence = searchSentence(learned);
      return [
        { ...entry, description: description === "" ? sentence : `${sentence} ${description}` },
      ];
    }
    return record(entry._meta)?.[RESIN_LEARNED_TOOL_META] === true && listedNames.has(name)
      ? [entry]
      : [];
  });
}

/** Pinned first, then those replacing the most recorded work, then by name. */
function listingOrder(a: CatalogNoticeTool, b: CatalogNoticeTool): number {
  if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1;
  const steps = (b.steps ?? 0) - (a.steps ?? 0);
  if (steps !== 0) return steps;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function listedLearnedTool(tool: CatalogNoticeTool): ListedLearnedTool {
  if (tool.listing !== undefined) {
    const { purpose, signature } = tool.listing;
    return { name: tool.name, signature, description: purpose };
  }
  return tool.description === undefined
    ? { name: tool.name }
    : { name: tool.name, description: tool.description };
}

/**
 * The listing a search-listing connection serves for a known catalog: the recommended learned
 * tools scoped to the caller's repository, as many of them, in {@link listingOrder}, as keep the
 * served surface (instructions and tool definitions, measured as served) within
 * {@link LISTING_CAP}. When even one does not fit, none is listed and search finds them.
 */
export function learnedToolListing(tools: readonly CatalogNoticeTool[]): LearnedToolListing {
  const relevant = tools
    .filter(
      (tool) =>
        tool._meta?.[RESIN_LEARNED_TOOL_META] === true &&
        tool.recommended !== false &&
        tool.scopedHere === true,
    )
    .sort(listingOrder);
  const served = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
  }));
  const listingOf = (listed: number): LearnedToolListing => ({
    count: relevant.length,
    commands: summarizeLearnedCommands(
      relevant.slice(listed).map((tool) => tool.localCommands ?? []),
    ),
    listing: relevant.slice(0, listed).map(listedLearnedTool),
  });
  for (let listed = Math.min(LISTING_CAP.maxTools, relevant.length); listed > 0; listed--) {
    const learned = listingOf(listed);
    const cost = searchListingTools(served, learned).reduce(
      (sum, tool) => sum + listingToolTokens(tool as unknown as ListingToolDefinition),
      listingTextTokens(searchListingInstructions(learned)),
    );
    if (cost <= LISTING_CAP.maxTokens) return learned;
  }
  return listingOf(0);
}
