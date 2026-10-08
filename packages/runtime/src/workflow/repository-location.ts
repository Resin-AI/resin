/**
 * Running a recorded step in the caller's own checkout (`WorkflowStep.location`), and deciding
 * whether a recorded workflow can run on this machine for this caller at all.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type RecordedWorkflow,
  type WorkflowJsonValue,
  type WorkflowStep,
  type WorkflowStepLocation,
  splitLeadingCd,
} from "@resin/contracts";
import { type RepositoryIdentity, repositoryIdentity } from "@resin/observer/repository-identity";

/** The git checkout an invocation's caller works in. */
export type CallerRepository = RepositoryIdentity;

/** Whether a recorded workflow can run here for this caller, and if not, why. */
export type WorkflowLocationAvailability =
  | { available: true }
  | { available: false; reason: string };

/** Argument names that carry a call's own working directory (OMP `cwd`, Codex `workdir`). */
export const WORKING_DIRECTORY_ARGUMENT_NAMES = ["cwd", "workdir", "workingDirectory"] as const;

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory a located step runs in for this caller: `<caller root>/<location.path>`. A reason
 * instead when the caller is not in a checkout of the step's repository or the directory does not
 * exist there — the step must then not run at all, anywhere.
 */
export function resolveStepLocation(
  location: WorkflowStepLocation,
  caller: CallerRepository | undefined,
): { directory: string } | { reason: string } {
  if (caller === undefined) {
    return {
      reason:
        "it runs inside a git repository, and the caller's working directory is not in a git checkout with commits",
    };
  }
  if (caller.id !== location.repository) {
    return { reason: "it was learned in a different repository than the caller's checkout" };
  }
  const segments = location.path.length === 0 ? [] : location.path.split("/");
  const directory = path.join(caller.root, ...segments);
  const relative = path.relative(caller.root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { reason: `its directory '${location.path}' is outside the caller's checkout` };
  }
  if (!isDirectory(directory)) {
    return {
      reason: `its directory '${location.path || "."}' does not exist in the caller's checkout`,
    };
  }
  return { directory };
}

export interface WorkflowLocationAvailabilityOptions {
  /** Identifies a directory's repository; defaults to `repositoryIdentity`. */
  identify?: (directory: string) => RepositoryIdentity | undefined;
  /** Resolves a private reference a recorded working-directory argument names, when possible. */
  resolvePrivate?: (reference: string) => unknown;
  homeDir?: string;
}

/** A private reference's value when it resolves to text here; undefined otherwise. */
function resolvePrivateText(
  reference: string,
  options: WorkflowLocationAvailabilityOptions,
): unknown {
  if (options.resolvePrivate === undefined) return undefined;
  try {
    return options.resolvePrivate(reference);
  } catch {
    return undefined;
  }
}

/** The absolute directory a legacy (unlocated) step pins itself to, when its record names one. */
function pinnedDirectories(
  step: WorkflowStep,
  options: WorkflowLocationAvailabilityOptions,
  homeDir: string,
): string[] {
  const pinned: string[] = [];
  const program = step.callable.program;
  if (program !== undefined && program.kind !== "patch") {
    // The program text is the source, or, for a program that arrived as a tool argument (a
    // harness's bash `command`), that argument's recorded text: a literal, a projected program's
    // literal source text (with the recorded values at its holes), or a private value.
    const carried =
      program.argument === undefined
        ? undefined
        : step.arguments.find((argument) => argument.name === program.argument)?.source;
    const text =
      carried === undefined
        ? program.source
        : carried.kind === "literal"
          ? carried.value
          : carried.kind === "template" &&
              carried.template.type === "program" &&
              carried.template.source.type === "literal"
            ? carried.template.source.value
            : carried.kind === "private"
              ? resolvePrivateText(carried.reference, options)
              : undefined;
    const cd = typeof text === "string" ? splitLeadingCd(text) : undefined;
    if (cd !== undefined) {
      const target = cd.home ? `${homeDir}${cd.directory}` : cd.directory;
      if (path.posix.isAbsolute(target)) pinned.push(target);
    }
  }
  for (const argument of step.arguments) {
    if (!(WORKING_DIRECTORY_ARGUMENT_NAMES as readonly string[]).includes(argument.name)) continue;
    let value: unknown;
    if (argument.source.kind === "literal") value = argument.source.value;
    else if (argument.source.kind === "private") {
      value = resolvePrivateText(argument.source.reference, options);
    }
    if (typeof value === "string" && path.isAbsolute(value)) pinned.push(value);
  }
  return pinned;
}

/**
 * Whether `plan` can run here for `caller`. Unavailable when:
 * - a located step's repository is not the caller's, or its directory is missing in the caller's
 *   checkout (see {@link resolveStepLocation});
 * - a step without a location pins an absolute directory — an absolute leading `cd` in its
 *   program, or a recorded absolute working-directory argument — that does not exist on this
 *   machine, or that lies in a checkout of another repository than the caller's.
 *
 * Search, listing and suggestions use it to leave out what cannot run here; an invocation refuses
 * with the reason instead of running somewhere else.
 */
export function workflowLocationAvailability(
  plan: Pick<RecordedWorkflow, "steps">,
  caller: { repository: CallerRepository | undefined },
  options: WorkflowLocationAvailabilityOptions = {},
): WorkflowLocationAvailability {
  const identify = options.identify ?? repositoryIdentity;
  const homeDir = options.homeDir ?? os.homedir();
  for (const step of plan.steps) {
    if (step.location !== undefined) {
      const resolved = resolveStepLocation(step.location, caller.repository);
      if ("reason" in resolved) return { available: false, reason: resolved.reason };
      continue;
    }
    for (const directory of pinnedDirectories(step, options, homeDir)) {
      if (!isDirectory(directory)) {
        return {
          available: false,
          reason: "it runs in a directory recorded on another checkout that does not exist here",
        };
      }
      const pinnedRepository = identify(directory);
      if (pinnedRepository !== undefined && pinnedRepository.id !== caller.repository?.id) {
        return {
          available: false,
          reason: "it runs in a checkout of a different repository than the caller's",
        };
      }
    }
  }
  return { available: true };
}

/**
 * The call a located step makes in `directory`: every recorded working-directory argument names
 * `directory`, and with `leadingCd` the program loses the `cd` it began with. The returned step is
 * a copy when its recorded program source changed; the plan itself is never modified.
 */
export function locateStepCall(
  step: WorkflowStep,
  args: Record<string, WorkflowJsonValue>,
  directory: string,
): { step: WorkflowStep; arguments: Record<string, WorkflowJsonValue> } {
  const located: Record<string, WorkflowJsonValue> = { ...args };
  for (const name of WORKING_DIRECTORY_ARGUMENT_NAMES) {
    if (Object.hasOwn(located, name) && typeof located[name] === "string") {
      located[name] = directory;
    }
  }
  let runStep = step;
  const program = step.callable.program;
  if (step.location?.leadingCd === true && program !== undefined) {
    const argument = program.argument;
    if (argument !== undefined && Object.hasOwn(located, argument)) {
      const text = located[argument];
      const cd = typeof text === "string" ? splitLeadingCd(text) : undefined;
      if (cd !== undefined) located[argument] = cd.rest;
    } else {
      const cd = splitLeadingCd(program.source);
      if (cd !== undefined) {
        runStep = {
          ...step,
          callable: { ...step.callable, program: { ...program, source: cd.rest } },
        };
      }
    }
  }
  return { step: runStep, arguments: located };
}
