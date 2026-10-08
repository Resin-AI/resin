/**
 * Which learned tools discovery offers a caller: a tool learned in one repository is offered only
 * in that repository (any clone or worktree of it), because it runs commands and paths that mean
 * nothing anywhere else. A tool that declares no repository and runs no step in a repository
 * location (an MCP query, a `gh` call taking `--repo` as an input) is offered everywhere; an older
 * tool without the declaration stays offered unless this machine knows it cannot run here.
 *
 * The scope comes from two places, merged: the catalog's `manifest.metadata.repositories` (the
 * repositories the tool's source recordings ran in) and the repositories the cached plan's
 * repository-located steps name. The caller's repository is the one enclosing the directory its
 * session started in. Both sides are the device-independent repository identity, so equality is
 * all that is compared; no path leaves this machine.
 */

import path from "node:path";
import type { ToolRegistry } from "../registry/registry.js";
import type { RegistryTool } from "../registry/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";
import { repositoryIdentity } from "./repository-identity.js";

/** The manifest metadata key holding the repository ids a learned tool was recorded in. */
export const TOOL_REPOSITORIES_METADATA_KEY = "repositories";

const REPOSITORY_ID = /^[0-9a-f]{64}$/u;

function repositoryIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((id): id is string => typeof id === "string" && REPOSITORY_ID.test(id)),
        ),
      ].sort()
    : [];
}

/**
 * The repository ids a tool's catalog entry declares, or undefined when it declares none: an older
 * tool, or one whose recordings carried no repository.
 */
export function toolRepositories(tool: Pick<RegistryTool, "manifest">): string[] | undefined {
  const ids = repositoryIds(tool.manifest?.metadata?.[TOOL_REPOSITORIES_METADATA_KEY]);
  return ids.length === 0 ? undefined : ids;
}

/**
 * Whether a tool's declared repositories admit `repositoryId`: always for a tool declaring none,
 * never for a scoped tool outside any repository. Considers the catalog declaration only; prefer
 * {@link isToolOfferedHere}, which also reads the tool's local plan.
 */
export function toolInRepository(
  tool: Pick<RegistryTool, "manifest">,
  repositoryId: string | undefined,
): boolean {
  const declared = toolRepositories(tool);
  return declared === undefined || (repositoryId !== undefined && declared.includes(repositoryId));
}

/** The directory a caller's session works in: where it started, else its project root. */
function callerDirectory(context: WorkspaceContext): string | undefined {
  const base = context.projectRoot || context.canonicalRoot;
  if (context.startupPath) {
    return base ? path.resolve(base, context.startupPath) : path.resolve(context.startupPath);
  }
  return base || undefined;
}

/** The repository the caller works in, or undefined outside one (or without git). */
export function callerRepositoryId(context: WorkspaceContext): string | undefined {
  const directory = callerDirectory(context);
  return directory === undefined ? undefined : repositoryIdentity(directory)?.id;
}

/** Whether discovery scopes this tool by repository at all: only learned (workspace) tools. */
function isLearnedTool(tool: Pick<RegistryTool, "isSystem" | "scope">): boolean {
  return (
    !tool.isSystem &&
    (tool.scope === undefined || tool.scope === "workspace" || tool.scope === "session")
  );
}

/**
 * Whether discovery offers `tool` to this caller: search, listing, catalog instructions and
 * get_tool_schema all ask this. A tool that cannot run here (its local plan says so) is never
 * offered; a tool scoped to repositories is offered only in one of them; any other tool is.
 */
export function isToolOfferedHere(
  registry: Pick<ToolRegistry, "learnedToolProfile">,
  tool: Pick<RegistryTool, "artifactDigest" | "manifest" | "isSystem" | "scope">,
  context: WorkspaceContext,
): boolean {
  if (!isLearnedTool(tool)) return true;
  const profile = registry.learnedToolProfile(tool, context);
  if (profile?.unavailableReason !== undefined) return false;
  const scope = new Set([
    ...(toolRepositories(tool) ?? []),
    ...repositoryIds(profile?.locatedRepositories ?? []),
  ]);
  if (scope.size === 0) return true;
  const caller = callerRepositoryId(context);
  return caller !== undefined && scope.has(caller);
}

/** What a caller is told when it names a tool that exists but is not offered where it works. */
export function unavailableHereMessage(name: string): string {
  return `Tool '${name}' is not available here: it was learned in another repository, or cannot run from this directory. Do the task with your usual tools.`;
}
