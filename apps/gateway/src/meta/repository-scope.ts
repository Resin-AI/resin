/**
 * Which learned tools discovery offers a caller: a tool learned in one repository is offered only
 * in that repository (any clone or worktree of it), because it runs commands and paths that mean
 * nothing anywhere else. A tool that declares no repository and runs no step in a repository
 * location (an MCP query, a `gh` call taking `--repo` as an input) is offered everywhere, unless
 * it is an older tool whose plan pins its directories (an absolute leading `cd`, a recorded
 * `cwd`/`workdir`) inside one repository: that tool is offered only there. Any tool this machine
 * knows cannot run here is not offered. Only a tool scoped to the caller's repository, or an
 * unscoped one the cloud observed in it, is listed (see {@link isToolScopedHere}); the others are
 * found by search or called by name.
 *
 * The scope comes from three places, merged: the catalog's `manifest.metadata.repositories` (the
 * repositories the tool's source recordings ran in), the repositories the cached plan's
 * repository-located steps name, and, for a tool with neither, the repository its plan's pinned
 * directories lie in. The caller's repository is the one enclosing the directory its session
 * started in. All are the device-independent repository identity, so equality is all that is
 * compared; no path leaves this machine.
 */

import { callerRepository } from "../proxy/tool-location.js";
import { recommendedOpportunities } from "../registry/recommendation.js";
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

/**
 * The repository the caller works in, or undefined outside one (or without git): the same
 * checkout a learned tool runs in (see `callerRepository`).
 */
export function callerRepositoryId(context: WorkspaceContext): string | undefined {
  return callerRepository(context, repositoryIdentity)?.id;
}

/** Whether discovery scopes this tool by repository at all: only learned (workspace) tools. */
function isLearnedTool(tool: Pick<RegistryTool, "isSystem" | "scope">): boolean {
  return (
    !tool.isSystem &&
    (tool.scope === undefined || tool.scope === "workspace" || tool.scope === "session")
  );
}

/**
 * Where a learned tool stands for this caller: `unavailable` when its local plan says it cannot run
 * here, `elsewhere` when it is scoped to repositories the caller is not in, `here` when it is scoped
 * to the caller's repository, and `unscoped` when nothing scopes it to a repository.
 */
function repositoryStanding(
  registry: Pick<ToolRegistry, "learnedToolProfile">,
  tool: Pick<RegistryTool, "artifactDigest" | "manifest">,
  context: WorkspaceContext,
): "unavailable" | "elsewhere" | "here" | "unscoped" {
  const profile = registry.learnedToolProfile(tool, context);
  if (profile?.unavailableReason !== undefined) return "unavailable";
  const declared = toolRepositories(tool) ?? [];
  const located = repositoryIds(profile?.locatedRepositories ?? []);
  // A legacy tool, declaring no repository and locating no step, is scoped by the directories its
  // plan pins when they all lie in one repository; a plan pinning none stays repo-agnostic.
  const pinned =
    declared.length === 0 && located.length === 0
      ? repositoryIds(profile?.pinnedRepository === undefined ? [] : [profile.pinnedRepository])
      : [];
  const scope = new Set([...declared, ...located, ...pinned]);
  if (scope.size === 0) return "unscoped";
  const caller = callerRepositoryId(context);
  return caller !== undefined && scope.has(caller) ? "here" : "elsewhere";
}

/**
 * Whether discovery offers `tool` to this caller: search, catalog instructions, get_tool_schema
 * and calls by name all ask this. A tool that cannot run here (its local plan says so) is never
 * offered; a tool scoped to repositories is offered only in one of them; any other tool is.
 */
export function isToolOfferedHere(
  registry: Pick<ToolRegistry, "learnedToolProfile">,
  tool: Pick<RegistryTool, "artifactDigest" | "manifest" | "isSystem" | "scope">,
  context: WorkspaceContext,
): boolean {
  if (!isLearnedTool(tool)) return true;
  const standing = repositoryStanding(registry, tool, context);
  return standing === "here" || standing === "unscoped";
}

/**
 * Whether a learned tool belongs to the caller's workspace: scoped to the repository the caller
 * works in and runnable there. Only these are listed and counted automatically. A tool declaring no
 * repository is offered (searchable and invocable by name) but listed only where the cloud
 * observed work it would have shortened (its recommendation's `opportunities.repositories`): MCP
 * calls carry no repository, so a tool made of them is otherwise unscoped, and every listed tool
 * costs context on every request.
 */
export function isToolScopedHere(
  registry: Pick<ToolRegistry, "learnedToolProfile">,
  tool: Pick<RegistryTool, "artifactDigest" | "manifest" | "isSystem" | "scope">,
  context: WorkspaceContext,
): boolean {
  if (!isLearnedTool(tool)) return false;
  const standing = repositoryStanding(registry, tool, context);
  if (standing !== "unscoped") return standing === "here";
  const observedIn = recommendedOpportunities(tool)?.repositories ?? [];
  if (observedIn.length === 0) return false;
  const caller = callerRepositoryId(context);
  return caller !== undefined && observedIn.includes(caller);
}

/** What a caller is told when it names a tool that exists but is not offered where it works. */
export function unavailableHereMessage(name: string): string {
  return `Tool '${name}' is not available here: it was learned in another repository, or cannot run from this directory. Do the task with your usual tools.`;
}
