/**
 * What this machine knows about a learned tool beyond its catalog entry, read from the recorded
 * plan it caches: how much recorded work the tool replaces, which repositories its located steps
 * run in, and whether it can run for the caller at all. Discovery ranks and scopes tools by it.
 * Nothing here is uploaded.
 */

import type { RecordedWorkflow } from "@resin/contracts";
import type { RegistryTool } from "../registry/types.js";
import type { WorkspaceContext } from "../workspace-resolver.js";

export interface ToolProfile {
  /** Recorded steps the tool replays (see {@link recordedWorkStepCount}); unknown when absent. */
  steps?: number;
  /**
   * What each recorded step runs, in plan order, as `step-runs` labels: a shell step's command
   * names, `<server>.<tool>` for an MCP call, a harness tool's name. Never a recorded argument.
   */
  runs?: readonly string[];
  /** Repository ids the plan's repository-located steps run in. */
  locatedRepositories?: readonly string[];
  /**
   * The repository a legacy plan (no located step) works in, when every directory it pins lies in
   * a checkout of that one repository (see `workflowPinnedRepository`).
   */
  pinnedRepository?: string;
  /** Why the tool cannot run for this caller (a recorded directory that is gone, say). */
  unavailableReason?: string;
}

/** The local profile of a learned tool, or undefined when this machine has no plan for it. */
export type LocalToolProfile = (
  tool: Pick<RegistryTool, "artifactDigest">,
  context: WorkspaceContext,
) => ToolProfile | undefined;

/** A step that only changes directory: setup for the next command, not work of its own. */
export const DIRECTORY_CHANGE = /^\s*(?:cd|pushd|popd)(?:\s+[^\s;&|]+)?\s*$/u;

/**
 * The recorded steps a plan replays: every recorded (not derived) step, except one that only
 * changes directory. Each segment of a recorded `&&` chain counts, so `pnpm build && pnpm test` is
 * two steps and `cd app && pnpm test` is one.
 */
export function recordedWorkStepCount(plan: Pick<RecordedWorkflow, "steps">): number {
  return plan.steps.filter((step) => {
    if (step.origin === "derivation") return false;
    const source = step.callable.program?.source;
    return source === undefined || !DIRECTORY_CHANGE.test(source);
  }).length;
}

/** The short hint a discovery result carries for a tool replacing more than one step. */
export function replacesStepsHint(steps: number | undefined): string | undefined {
  return steps !== undefined && steps > 1 ? `Replaces ${steps} recorded steps.` : undefined;
}

const MULTI_STEP_BONUS_PER_DOUBLING = 3;
const MULTI_STEP_BONUS_CAP = 9;

/**
 * The ranking bonus for replacing more recorded work: zero for a single-command wrapper, growing
 * with the logarithm of the step count and capped, so it orders tools of similar relevance without
 * lifting a multi-step tool over one that matches the query clearly better.
 */
export function multiStepBonus(steps: number | undefined): number {
  if (steps === undefined || steps <= 1) return 0;
  return Math.min(MULTI_STEP_BONUS_CAP, MULTI_STEP_BONUS_PER_DOUBLING * Math.log2(steps));
}
