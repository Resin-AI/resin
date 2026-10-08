/**
 * Where a learned tool runs for the agent calling it: the caller's own git checkout. Search,
 * listing and suggestions leave out a tool that cannot run there; an invocation refuses it with
 * the reason instead of running it somewhere else.
 */

import type { RecordedWorkflow } from "@resin/contracts";
import { type RepositoryIdentity, repositoryIdentity } from "@resin/observer/repository-identity";
import {
  type CallerRepository,
  type WorkflowLocationAvailability,
  type WorkflowLocationAvailabilityOptions,
  workflowLocationAvailability,
} from "@resin/runtime";
import { type WorkspaceContext, sessionWorkingDirectory } from "../workspace-resolver.js";

/** What locates the caller: the connection's workspace roots and the session's own directory. */
export type CallerContext = Partial<
  Pick<WorkspaceContext, "projectRoot" | "canonicalRoot" | "startupPath" | "roots">
>;

/**
 * The checkout the caller works in: the git repository enclosing the session's own directory (the
 * MCP connection's workspace root, refined by the directory the harness session started in).
 * Undefined outside a git checkout with commits.
 */
export function callerRepository(
  context: CallerContext | undefined,
  identify: (directory: string) => RepositoryIdentity | undefined = repositoryIdentity,
): CallerRepository | undefined {
  const projectRoot = context?.projectRoot ?? context?.canonicalRoot ?? context?.roots?.[0]?.path;
  if (projectRoot === undefined || projectRoot.length === 0) return undefined;
  const directory = sessionWorkingDirectory(
    context?.startupPath === undefined ? undefined : { startupPath: context.startupPath },
    projectRoot,
  );
  return identify(directory);
}

/** Whether a recorded-workflow tool's plan can run for the caller `context` describes. */
export function toolRunnableHere(
  plan: Pick<RecordedWorkflow, "steps">,
  context: CallerContext | undefined,
  options: WorkflowLocationAvailabilityOptions = {},
): WorkflowLocationAvailability {
  return workflowLocationAvailability(
    plan,
    { repository: callerRepository(context, options.identify) },
    options,
  );
}
