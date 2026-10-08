/**
 * Keeps the command-suggestion index current from inside `resin mcp`: each time the gateway lists
 * a connection's known catalog (initialize, tools/list, a catalog change), the learned tools it
 * offers there, with the commands their recorded programs run, replace that repository's entry.
 * The catalog is already scoped to the connection's repository by the router, so the index is too.
 */
import { RESIN_LEARNED_TOOL_META } from "../protocol/types.js";
import { callerRepository } from "../proxy/tool-location.js";
import type { CatalogNoticeTool } from "../router.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { type SuggestTool, writeRepositoryTools } from "./index-file.js";
import { type RepositoryIdentityResolver, repositoryIdentity } from "./repository-identity.js";

export type CatalogListedObserver = (
  context: WorkspaceContext,
  tools: readonly CatalogNoticeTool[],
) => void;

export interface CommandSuggestIndexWriterOptions {
  /** The command-suggest directory (`resolveCommandSuggestDir`). */
  readonly dir: string;
  readonly repositoryIdentity?: RepositoryIdentityResolver;
  /** Reports a failed write; the gateway keeps serving either way. */
  readonly onError?: (error: unknown) => void;
}

/**
 * The index entries for a listed catalog: learned tools that run at least one command, except
 * those measured to cost more than running the command directly.
 */
export function suggestToolsFromCatalog(tools: readonly CatalogNoticeTool[]): SuggestTool[] {
  const result: SuggestTool[] = [];
  for (const tool of tools) {
    if (tool._meta?.[RESIN_LEARNED_TOOL_META] !== true || tool.recommended === false) continue;
    const commands = tool.localCommands ?? [];
    if (commands.length === 0) continue;
    const required = new Set(tool.inputSchema.required ?? []);
    result.push({
      name: tool.name,
      commands: [...commands],
      inputs: Object.keys(tool.inputSchema.properties ?? {}).map((name) => ({
        name,
        required: required.has(name),
      })),
    });
  }
  return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** An observer that writes each listed catalog to the index under its repository's identity. */
export function createCommandSuggestIndexWriter(
  options: CommandSuggestIndexWriterOptions,
): CatalogListedObserver {
  const resolve = options.repositoryIdentity ?? repositoryIdentity;
  /** What this process last wrote per repository, so an unchanged listing reads no file. */
  const written = new Map<string, string>();
  return (context, tools) => {
    try {
      // The same checkout the router scoped the catalog to and the tools run in.
      const identity = callerRepository(context, resolve);
      if (identity === undefined) return;
      const entries = suggestToolsFromCatalog(tools);
      const key = JSON.stringify(entries);
      if (written.get(identity.id) === key) return;
      writeRepositoryTools(options.dir, identity.id, entries);
      written.set(identity.id, key);
    } catch (error) {
      options.onError?.(error);
    }
  };
}
