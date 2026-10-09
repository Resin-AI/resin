import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CapabilityManifestSchema,
  type CommandCapability,
  type FsCapability,
  IdentifierSchema,
  type InvocationFailureReason,
  type RecordedWorkflow,
  type ToolManifest,
  ToolManifestSchema,
  type WorkflowJsonValue,
  type WorkflowStep,
  type WorkflowValueSource,
  type WorkflowValueTemplate,
  canonicalJson,
  displayFilterPipelines,
  displayFilterShell,
  embeddedPrograms,
  normalizeSha256,
  splitDisplayFilter,
  splitDisplayFilters,
  tokenizeProgram,
  validateRecordedWorkflow,
  workflowLocationRepositories,
  workflowSinkStepIds,
} from "@resin/contracts";
import {
  FilePrivateValueStore,
  type PrivateValueStore,
  RESIN_INVOKE_TOOL_RUNTIME,
  resolvePrivateReference,
} from "@resin/observer";
import { recordDiscoveryFunnelEvent } from "@resin/observer/discovery-funnel";
import {
  type ArtifactCache,
  BUNDLE_FILE_ENTRYPOINT_JS,
  BUNDLE_FILE_ENTRYPOINT_TS,
  BUNDLE_FILE_MANIFEST,
  BUNDLE_FILE_SIGNATURE,
  BundleSignatureDataSchema,
  CapabilityBrokerManager,
  type CapabilityPolicyEngine,
  type CompiledWorkflowArtifact,
  DEFAULT_BUNDLE_LIMITS,
  type KeyStore,
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  type RecordedStepOutcome,
  type RecordedWorkflowExecution,
  type RuntimeAdapter,
  RuntimeAdapterRegistry,
  ToolBundleLoader,
  type WorkerExecutionResult,
  WorkerProcess,
  type WorkflowLocationAvailability,
  createInvocationGrant,
  createInvocationOutputDirectory,
  encodeDeterministicTar,
  inspectArtifactImports,
  instantiateRecordedWorkflow,
  pruneInvocationOutputs,
  recordedWorkflowInputSchema,
  resolveDenoExecutable,
  timeRecordedCall,
  validateBundleEntryPath,
  verifyBundleSignature,
  workflowLocationAvailability,
} from "@resin/runtime";
import {
  isDatedValue,
  missingDatedInputs,
  missingDatedInputsMessage,
} from "../meta/dated-defaults.js";
import { failedToolResult } from "../meta/invocation-failure.js";
import { missingInputsResult, missingRequiredInputs } from "../meta/missing-inputs.js";
import { scrubPrivateValues, scrubbablePrivateValues } from "../meta/private-values.js";
import { type ToolProfile, recordedWorkStepCount } from "../meta/tool-profile.js";
import {
  type CallToolResult,
  type JsonRpcParams,
  RESIN_DISPLAY_TEXT_META,
  RESIN_OUTPUT_STEPS_META,
} from "../protocol/types.js";
import { computeManifestDigest, computeSha256 } from "../registry/validator.js";
import { type WorkspaceContext, sessionWorkingDirectory } from "../workspace-resolver.js";
import { CommandFailureDiagnostics } from "./command-failures.js";
import type { ManagedToolAccess } from "./tool-access.js";
import { callerRepository, toolRunnableHere } from "./tool-location.js";

import {
  type OutputStepNumbers,
  composedResultValue,
  presentStepSections,
} from "../meta/invoke-tool.js";
import { programCommands } from "../meta/learned-commands.js";

/** A completed step's output as text: printed text as is, any other value as JSON. */
function stepOutputText(value: RecordedStepOutcome & { status: "completed" }): string {
  const result = value.result;
  return typeof result === "string" ? result : result === null ? "" : JSON.stringify(result);
}

/**
 * What a cached recorded workflow runs, as this machine may show it: the description of its steps
 * (none when no step can be shown), the commands its programs run, its dated recorded-default inputs
 * with their recorded values as shown, and the private values no shown text may contain.
 *
 * Shown text reaches the model provider and the harness transcript, so it holds only what the plan
 * itself carries: a private value appears as a `<private:N>` placeholder, never resolved.
 */
interface RecordedWorkflowSummary {
  description: string | undefined;
  commands: string[];
  dated: ReadonlyMap<string, string>;
  /** Every resolved private value of the plan (4+ characters), longest first, for scrubbing. */
  privateValues: readonly string[];
  /** Each recorded-default input's one recorded value, when the plan itself carries it. */
  defaults: ReadonlyMap<string, string>;
}

/** Where one private value sits in a recorded text resolved on this machine. */
interface PrivateRange {
  start: number;
  end: number;
  reference: string;
}

/** Why a worker that did not succeed failed: a worker that never ran means no usable runtime. */
function workerFailureReason(result: WorkerExecutionResult): InvocationFailureReason {
  if (
    result.status === "timeout" ||
    result.status === "cancelled" ||
    result.status === "validation_error"
  ) {
    return result.status;
  }
  return result.error?.type === "spawn_error" ? "runtime_unavailable" : "tool_error";
}

/** "1", "1 and 2", "1, 2 and 3". */
function joinStepNumbers(numbers: readonly number[]): string {
  return numbers.length <= 1
    ? numbers.join("")
    : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
}

/** The most characters one completed step's output shows in a failure report. */
const FAILED_REPORT_STEP_CHARS = 2_000;
/** The most characters all completed steps' outputs show together in a failure report. */
const FAILED_REPORT_OUTPUT_CHARS = 8_000;

/**
 * A completed step's output as a failure report shows it: whole when it fits `budget`, else its
 * last part, with the whole output written to `file` (when one could be written) and named.
 */
async function boundedStepOutput(
  text: string,
  budget: number,
  file: () => Promise<string | undefined>,
): Promise<string> {
  if (text.length <= budget) return text;
  const kept = await file().catch(() => undefined);
  const note = `…[output shortened to its last part${kept === undefined ? "" : `; all of it is in ${kept}`}]\n`;
  const keep = Math.max(0, budget - note.length);
  return `${note}${keep > 0 ? text.slice(text.length - keep) : ""}`;
}

/**
 * What a failed recorded workflow did, by plan step: the step that failed and its error (which
 * carries what it printed), then each step that completed before it, in plan order, with its
 * output, the steps that never ran, and a warning that completed steps' effects already happened.
 * Steps after a failure never run: a later step may depend on what the failed one did. Only what
 * the steps returned is shown, never their recorded programs. A derivation computes inputs and has
 * no effects, so it is counted but not shown.
 *
 * Each completed output is bounded (`FAILED_REPORT_STEP_CHARS`, and `FAILED_REPORT_OUTPUT_CHARS`
 * shared by all of them): a longer one shows its last part, and its whole text is kept in a fresh
 * capture directory under `outputRoot` (or a private temporary one), pruned like a display-filter
 * step's. A display-filter step's own report is already bounded and is shown as it is.
 */
async function failedWorkflowReport(
  plan: RecordedWorkflow,
  execution: RecordedWorkflowExecution,
  outputRoot: string | undefined,
): Promise<string | undefined> {
  const total = plan.steps.length;
  const numberOf = new Map(plan.steps.map((step, index) => [step.id, index + 1]));
  const derivations = new Set(
    plan.steps.flatMap((step) => (step.origin === "derivation" ? [step.id] : [])),
  );
  const failures = execution.steps.flatMap((outcome) =>
    outcome.status === "failed" ? [outcome] : [],
  );
  const failed = failures[0];
  if (failed === undefined) return undefined;
  const completed = execution.steps.flatMap((outcome) =>
    outcome.status === "completed" && !derivations.has(outcome.stepId) ? [outcome] : [],
  );
  const lines = [`Step ${numberOf.get(failed.stepId)} of ${total} failed: ${failed.error}`];
  if (completed.length > 0) {
    lines.push(
      completed.length === 1
        ? "Output of the step that completed before it:"
        : "Outputs of the steps that completed before it:",
    );
  }
  const budget = Math.min(
    FAILED_REPORT_STEP_CHARS,
    Math.floor(FAILED_REPORT_OUTPUT_CHARS / Math.max(1, completed.length)),
  );
  let directory: Promise<string> | undefined;
  for (const outcome of completed) {
    const number = numberOf.get(outcome.stepId);
    const output =
      outcome.display ??
      (await boundedStepOutput(stepOutputText(outcome), budget, async () => {
        directory ??= createInvocationOutputDirectory(outputRoot);
        const kept = path.join(await directory, `step-${number}.txt`);
        await fs.promises.writeFile(kept, stepOutputText(outcome), { mode: 0o600 });
        return kept;
      }));
    lines.push(`--- step ${number}/${total} ---\n${output}`);
  }
  if (directory !== undefined) await pruneInvocationOutputs(await directory).catch(() => {});
  for (const outcome of failures.slice(1)) {
    lines.push(`Step ${numberOf.get(outcome.stepId)} of ${total} also failed: ${outcome.error}`);
  }
  const notRun = execution.steps.flatMap((outcome) =>
    outcome.status === "skipped"
      ? [`step ${numberOf.get(outcome.stepId)}/${total}`]
      : outcome.status === "omitted"
        ? [`step ${numberOf.get(outcome.stepId)}/${total} (turned off)`]
        : [],
  );
  if (notRun.length > 0) lines.push(`Did not run: ${notRun.join(", ")}.`);
  const ran = completed.flatMap((outcome) => {
    const number = numberOf.get(outcome.stepId);
    return number === undefined ? [] : [number];
  });
  lines.push(
    ran.length === 0
      ? "No step completed before the failure."
      : ran.length === 1
        ? `Step ${ran[0]} completed and its effects already happened: do not rerun it blindly; invoking this tool again repeats it.`
        : `Steps ${joinStepNumbers(ran)} completed and their effects already happened: do not rerun them blindly; invoking this tool again repeats them.`,
  );
  return lines.join("\n");
}

export interface LocalArtifactEntry {
  toolId: string;
  name?: string;
  version?: string;
  artifactDigest: string;
  manifestDigest?: string;
  status?: string;
  signatureIdentity?: {
    keyId: string;
    algorithm?: string;
  };
}

export interface LocalArtifactExecuteParams {
  entry: LocalArtifactEntry;
  manifest?: ToolManifest;
  parameters: JsonRpcParams;
  context: WorkspaceContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: number, total?: number) => void;
}

/**
 * What a host needs to build the runtime families it can execute, for one invocation.
 *
 * `routeToHost` is the invocation's own routing, so a step the host reaches the same way it reached
 * the original call keeps the workspace, the deadline and the cancellation that apply now.
 */
export interface RecordedWorkflowHostContext {
  manifest: ToolManifest;
  workspace: WorkspaceContext;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Where a recorded program step keeps each invocation's full output (`<resinHome>/data/
   * invocation-output`), for the caller to read without re-running it. Absent without a Resin home.
   */
  invocationOutputRoot?: string;
  routeToHost: (request: {
    name: string;
    connection?: string;
    parameters: Record<string, unknown>;
  }) => Promise<CallToolResult>;
}

export interface LocalArtifactExecutorOptions {
  cache: ArtifactCache;
  loader?: ToolBundleLoader | (() => ToolBundleLoader);
  workspaceRoot?: string;
  brokerManager?: CapabilityBrokerManager;
  policyEngine?: CapabilityPolicyEngine;
  keyStore?: KeyStore;
  allowDevKeys?: boolean;
  development?: boolean;
  denoExecutable?: string;
  resinHome?: string;
  requireSignature?: boolean;
  /**
   * Dispatches a recorded workflow's step to its callable through the same routing the
   * original call used. Required for `recorded-workflow` artifacts; without it a plan
   * cannot execute and the call reports that honestly.
   */
  stepInvoker?: (request: {
    name: string;
    connection?: string;
    parameters: Record<string, unknown>;
    context: WorkspaceContext;
    signal?: AbortSignal;
    timeoutMs?: number;
  }) => Promise<CallToolResult>;
  /**
   * Runtime families this host can execute a recorded plan through, besides the call routing every
   * host has. A plan naming a family no host provides fails with that reason instead of a
   * substitute behaviour, so a recording of ordinary tools runs only where the host can really
   * reach them.
   *
   * The hosts are built per invocation because a step that goes back through this host's routing
   * needs the invoking workspace, its deadline and its cancellation.
   */
  recordedWorkflowAdapters?: (host: RecordedWorkflowHostContext) => readonly RuntimeAdapter[];
  /** Store private workflow references resolve against; defaults to the daemon store. */
  privateValueStore?: PrivateValueStore;
  /**
   * Authoritative tenant that owns captured private values. This is distinct from the local
   * project UUID in WorkspaceContext, which scopes catalog installation and execution.
   */
  privateValueOwnerWorkspaceId?: string;
}

/** Longest program preview a recorded step shows; the full text still executes. */
const RECORDED_PROGRAM_PREVIEW_CHARS = 600;
/** Added lines of a recorded edit shown in its description; the whole edit still applies. */
const RECORDED_PATCH_PREVIEW_LINES = 12;
/** Characters of a harness tool argument's recorded text shown in a tool description. */
const RECORDED_NATIVE_ARGUMENT_CHARS = 120;
/** Where a private value sits in projected program text: no command name can be read from it. */
const PROJECTED_PRIVATE_VALUE = "[private]";
/**
 * OMP's built-in tools take `i`, a one-line statement of intent for the transcript: narration, not
 * the call's data. Recordings made before the decoder kept it as metadata still carry it.
 */
const OMP_INTENT_ARGUMENT = "i";
/**
 * Characters of recorded steps one tool description may carry. Tool listings leave the recorded
 * steps out; get_tool_schema and search_tools return them, and each result stays in the agent's
 * context for the rest of the session, so a long recording is still capped.
 */
const RECORDED_STEPS_BUDGET_CHARS = 2000;
/** Preview sizes tried in turn, largest first, until the recorded steps fit their budget. */
const RECORDED_PREVIEW_STEPS = [RECORDED_PROGRAM_PREVIEW_CHARS, 400, 250, 160, 100];

export interface RecordedStep {
  /** The step's first line: its number and what it does. */
  head: string;
  /** The program text or added lines the step shows under its head, trimmed to fit the budget. */
  body?: string;
  /** What an invocation of the step returns, shown whole after its body (see {@link displayFilterNote}). */
  note?: string;
}

/**
 * Renders recorded steps within `budget` characters: previews shrink together (each step keeps its
 * head, the start of its body and its note) until they fit, and when even the smallest preview does
 * not, the steps that no longer fit are counted instead of shown.
 */
export function renderRecordedSteps(
  steps: readonly RecordedStep[],
  budget: number = RECORDED_STEPS_BUDGET_CHARS,
): string {
  const render = (step: RecordedStep, limit: number): string => {
    const lines = [step.head];
    if (step.body !== undefined) {
      lines.push(step.body.length > limit ? `${step.body.slice(0, limit)}\n[...]` : step.body);
    }
    if (step.note !== undefined) lines.push(step.note);
    return lines.join("\n");
  };
  const join = (parts: readonly string[]): string => parts.join("\n");
  for (const limit of RECORDED_PREVIEW_STEPS) {
    const parts = steps.map((step) => render(step, limit));
    if (join(parts).length <= budget) return join(parts);
  }
  const smallest = RECORDED_PREVIEW_STEPS[RECORDED_PREVIEW_STEPS.length - 1]!;
  const parts = steps.map((step) => render(step, smallest));
  const kept: string[] = [];
  let size = 0;
  for (const part of parts) {
    if (kept.length > 0 && size + part.length + 1 > budget) break;
    kept.push(part);
    size += part.length + 1;
  }
  const omitted = parts.length - kept.length;
  return omitted === 0
    ? join(kept)
    : `${join(kept)}\n[${omitted} more step${omitted === 1 ? "" : "s"} not shown]`;
}

/** The longest display filter a {@link displayFilterNote} quotes. */
const NOTED_FILTER_CHARS = 60;

/**
 * What an invocation of a display-filter step returns, read from the step's compiled
 * `displayFilter` and its program's top-level pipelines, as `runRecordedCall` in @resin/runtime
 * runs it: version 1 runs without the filter its last pipeline ended in, so the whole output and
 * the command's own exit status come back; version 2 runs as recorded and its report adds the
 * diagnostic lines the filters hid, keeps the unfiltered output in files and, when a command
 * fails, lists each command's exit status. A command after `&&` is named with the one it waits
 * on, since it runs only if that one succeeded; after a filtered pipeline the filter's status
 * decides instead, so no such claim is made. An agent shown only the recorded program passed over
 * an exact match, reasoning that its `&& … | tail -3` would hide findings. Undefined for any other
 * step.
 */
function displayFilterNote(step: WorkflowStep): string | undefined {
  const version = step.displayFilter?.version;
  const program = step.callable.program;
  if (version === undefined || program === undefined) return undefined;
  // The recorded shell is read from literal arguments only (a Codex shell profile), as validation does.
  const literals: Record<string, unknown> = {};
  for (const argument of step.arguments) {
    if (argument.source.kind === "literal") literals[argument.name] = argument.source.value;
  }
  const shell = displayFilterShell(step.callable.name, literals, program);
  if (shell === undefined) return undefined;
  const filters = (
    version === 1
      ? [splitDisplayFilter(shell, program.source, version)?.filter]
      : (splitDisplayFilters(shell, program.source, version)?.cuts.map((cut) => cut.filter) ?? [])
  ).flatMap((filter) =>
    filter === undefined
      ? []
      : [
          filter.length > NOTED_FILTER_CHARS
            ? `${filter.slice(0, NOTED_FILTER_CHARS - 1)}…`
            : filter,
        ],
  );
  if (filters.length === 0) return undefined;
  // Version 1's pipelines are read with version 2's lexer, which reads version 1's grammar; a
  // program it refuses names no chain.
  const pipelines =
    displayFilterPipelines(shell, program.source, version === 1 ? 2 : version) ?? [];
  const label = (index: number): string => {
    const command = pipelines[index]?.command;
    const unique =
      command !== undefined && pipelines.filter((each) => each.command === command).length === 1;
    return unique
      ? `\`${command}\``
      : `command ${index + 1}${command === undefined ? "" : ` (\`${command}\`)`}`;
  };
  const chain = pipelines
    .flatMap((pipeline, index) =>
      pipeline.next === "&&" && pipeline.cut === undefined && index + 1 < pipelines.length
        ? [`${label(index + 1)} runs only if ${label(index)} succeeds`]
        : [],
    )
    .join("; ");
  if (version === 1) {
    return `When invoked, it runs without the final \`| ${filters[0]}\`, so the full output comes back and the command's own exit status decides success${chain === "" ? "" : `; ${chain}`}.`;
  }
  return `When invoked, it runs as recorded${chain === "" ? "" : `: ${chain}`}. Its output adds the error, warning and failure lines ${filters.map((filter) => `\`${filter}\``).join(" and ")} hid, with the unfiltered output kept in files; if a command fails, the call fails listing each command's exit status.`;
}

function isRegularFileWithoutFollowingSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findDenoBinary(
  options?: { denoExecutable?: string; resinHome?: string } | string,
): string {
  const opts = typeof options === "string" ? { denoExecutable: options } : options;
  return resolveDenoExecutable(opts) ?? opts?.denoExecutable ?? "deno";
}

function inspectArtifactSourceGraph(
  entrypointPath: string,
  artifactDir: string,
): { passed: boolean; errors: string[] } {
  const errors = new Set<string>();
  const rootPath = path.resolve(artifactDir);
  let rootRealPath: string;

  try {
    const rootStat = fs.lstatSync(rootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return {
        passed: false,
        errors: ["Artifact root must be a regular directory; symbolic-link roots are unsupported."],
      };
    }
    rootRealPath = fs.realpathSync(rootPath);
  } catch (error) {
    return {
      passed: false,
      errors: [
        `Failed to inspect artifact root '${rootPath}': ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const isWithinRoot = (candidate: string, root: string): boolean =>
    candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const absoluteEntrypoint = path.resolve(entrypointPath);
  const relativeEntrypoint = path.relative(rootPath, absoluteEntrypoint);
  if (
    !relativeEntrypoint ||
    path.isAbsolute(relativeEntrypoint) ||
    relativeEntrypoint === ".." ||
    relativeEntrypoint.startsWith(`..${path.sep}`)
  ) {
    return {
      passed: false,
      errors: [`Artifact entrypoint '${entrypointPath}' escapes the artifact root.`],
    };
  }

  const entrypoint = relativeEntrypoint.split(path.sep).join("/");
  const files = new Map<string, string>();
  const maxFiles = DEFAULT_BUNDLE_LIMITS.maxFileCount ?? 1_000;
  const maxBytes = DEFAULT_BUNDLE_LIMITS.maxBundleSizeBytes ?? 50 * 1024 * 1024;
  const maxSingleFileBytes = DEFAULT_BUNDLE_LIMITS.maxFileSizeBytes ?? 10 * 1024 * 1024;
  const maxEntries = Math.max(maxFiles * 2, 1_024);
  const maxDirectoryDepth = 64;
  let totalBytes = 0;
  let entryCount = 0;
  let traversalLimitError: string | undefined;

  const collectFiles = (currentDir: string, relativeBase: string, depth: number): void => {
    if (traversalLimitError) return;
    if (depth > maxDirectoryDepth) {
      traversalLimitError = `Artifact directory depth exceeds the maximum of ${maxDirectoryDepth}.`;
      errors.add(traversalLimitError);
      return;
    }

    let directory: fs.Dir;
    try {
      directory = fs.opendirSync(currentDir);
    } catch (error) {
      errors.add(
        `Failed to read artifact directory '${relativeBase || "."}': ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    try {
      while (!traversalLimitError) {
        const dirent = directory.readSync();
        if (dirent === null) break;
        entryCount += 1;
        if (entryCount > maxEntries) {
          traversalLimitError = `Artifact directory entries exceed the maximum of ${maxEntries}.`;
          errors.add(traversalLimitError);
          break;
        }

        const fullPath = path.join(currentDir, dirent.name);
        const relativePath = relativeBase ? `${relativeBase}/${dirent.name}` : dirent.name;
        try {
          validateBundleEntryPath(relativePath);
        } catch (error) {
          errors.add(
            `Artifact file '${relativePath}' is not a valid bundle path: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(fullPath);
        } catch (error) {
          errors.add(
            `Failed to inspect artifact file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        if (stat.isSymbolicLink()) {
          errors.add(
            `Artifact file '${relativePath}' is a symbolic link and cannot be inspected safely.`,
          );
          continue;
        }
        if (stat.isDirectory()) {
          let realDirectory: string;
          try {
            realDirectory = fs.realpathSync(fullPath);
          } catch (error) {
            errors.add(
              `Failed to resolve artifact directory '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          if (!isWithinRoot(realDirectory, rootRealPath)) {
            errors.add(`Artifact directory '${relativePath}' resolves outside the artifact root.`);
            continue;
          }
          collectFiles(fullPath, relativePath, depth + 1);
          continue;
        }
        if (!stat.isFile()) {
          errors.add(`Artifact file '${relativePath}' is not a regular file.`);
          continue;
        }
        if (relativePath === ".extracted") continue;
        if (files.size >= maxFiles) {
          traversalLimitError = `Artifact contains more than the maximum of ${maxFiles} files.`;
          errors.add(traversalLimitError);
          break;
        }
        if (stat.size > maxSingleFileBytes || totalBytes + stat.size > maxBytes) {
          traversalLimitError = "Artifact source files exceed the configured bundle size limits.";
          errors.add(traversalLimitError);
          break;
        }

        let realPath: string;
        try {
          realPath = fs.realpathSync(fullPath);
        } catch (error) {
          errors.add(
            `Failed to resolve artifact file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        if (!isWithinRoot(realPath, rootRealPath)) {
          errors.add(`Artifact file '${relativePath}' resolves outside the artifact root.`);
          continue;
        }

        try {
          files.set(relativePath, fs.readFileSync(fullPath, "utf8"));
        } catch (error) {
          errors.add(
            `Failed to read artifact file '${relativePath}': ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        totalBytes += stat.size;
      }
    } catch (error) {
      errors.add(
        `Failed to read artifact directory '${relativeBase || "."}': ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        directory.closeSync();
      } catch {
        // Best effort: the original read error is more actionable.
      }
    }
  };

  collectFiles(rootPath, "", 0);

  if (errors.size > 0) {
    return { passed: false, errors: [...errors].sort() };
  }

  const inspection = inspectArtifactImports({ entrypoint, files });
  return inspection;
}

/**
 * Whether an identity may scope a private reference. It is the same identifier the contracts use
 * for a workspace (`WorkspaceRecordSchema.workspaceId`), so every workspace this product issues —
 * a bootstrapped project UUID or a path-derived `ws_*` id — qualifies, while an absent, empty, or
 * malformed value does not. A value that is not a usable identity is not an identity: it makes the
 * reference unavailable rather than globally available.
 */
function isUsableWorkspaceId(value: unknown): value is string {
  return typeof value === "string" && IdentifierSchema.safeParse(value).success;
}

function matchesManifestDigest(manifest: ToolManifest, expectedDigest: string): boolean {
  try {
    const normExpected = normalizeSha256(expectedDigest, false);
    const digest1 = normalizeSha256(computeManifestDigest(manifest), false);
    if (digest1 === normExpected) return true;
    const digest2 = normalizeSha256(computeSha256(canonicalJson(manifest)), false);
    if (digest2 === normExpected) return true;
    if (manifest.digest && normalizeSha256(manifest.digest, false) === normExpected) return true;
    return false;
  } catch {
    return false;
  }
}

export class LocalArtifactExecutor {
  readonly cache: ArtifactCache;
  private readonly loaderInstance?: ToolBundleLoader | (() => ToolBundleLoader);
  private workspaceRoot: string;
  private readonly brokerManager?: CapabilityBrokerManager;
  private readonly policyEngine?: CapabilityPolicyEngine;
  private readonly keyStore?: KeyStore;
  private readonly allowDevKeys: boolean;
  private readonly development: boolean;
  private readonly denoExecutable?: string;
  private readonly resinHome?: string;
  private readonly requireSignature?: boolean;
  private readonly stepInvoker?: LocalArtifactExecutorOptions["stepInvoker"];
  private readonly recordedWorkflowAdapters?: LocalArtifactExecutorOptions["recordedWorkflowAdapters"];
  private readonly privateValueStore?: LocalArtifactExecutorOptions["privateValueStore"];
  private readonly privateValueOwnerWorkspaceId?: string;
  private managedToolAccess?: ManagedToolAccess;
  /** Resolved local summaries by artifact and owning workspace; both are immutable inputs. */
  private readonly recordedWorkflowSummaries = new Map<string, RecordedWorkflowSummary>();
  /** Parsed recorded plans by artifact digest: an artifact's bytes never change under its digest. */
  private readonly recordedPlans = new Map<string, RecordedWorkflow>();

  constructor(options: LocalArtifactExecutorOptions) {
    this.cache = options.cache;
    this.loaderInstance = options.loader;
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.brokerManager = options.brokerManager;
    this.policyEngine = options.policyEngine;
    this.keyStore = options.keyStore;
    this.allowDevKeys = options.allowDevKeys ?? false;
    this.development = options.development ?? options.allowDevKeys ?? true;
    this.denoExecutable = options.denoExecutable;
    this.resinHome = options.resinHome;
    this.requireSignature = options.requireSignature;
    this.stepInvoker = options.stepInvoker;
    this.recordedWorkflowAdapters = options.recordedWorkflowAdapters;
    this.privateValueStore = options.privateValueStore;
    this.privateValueOwnerWorkspaceId = options.privateValueOwnerWorkspaceId;
  }

  setManagedToolAccess(access: ManagedToolAccess): void {
    this.managedToolAccess = access;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * The store this executor resolves a plan's private references from. A companion service that
   * replays a recording must resolve them from the same place the executor would, or a value would
   * be available on one path and not the other.
   */
  getPrivateValueStore(): PrivateValueStore {
    return this.privateValueStore ?? FilePrivateValueStore.default();
  }

  /**
   * What a cached recorded workflow runs, for tool discovery on this machine, shown only to the
   * recording workspace. The text reaches the model provider and the harness transcript, so it holds
   * only what the plan carries: a projected program's sanitized text, `{input}` for each caller
   * value and a `<private:N>` placeholder for each private value, never a resolved one.
   */
  describeRecordedWorkflow(artifactDigest: string, context: WorkspaceContext): string | undefined {
    return this.recordedWorkflowSummary(artifactDigest, context)?.description;
  }

  /**
   * The resolved private values of a cached recorded workflow (string leaves of 4+ characters,
   * longest first): what meta-tool text scrubs before it is returned, so no path can show one.
   */
  recordedWorkflowPrivateValues(
    artifactDigest: string,
    context: WorkspaceContext,
  ): readonly string[] {
    return this.recordedWorkflowSummary(artifactDigest, context)?.privateValues ?? [];
  }

  /**
   * The commands a cached recorded workflow's shell programs run (`gh pr checks`, `vitest`), so
   * an agent can tell from those names alone that a learned tool covers a command it is about to
   * type. Unlike {@link describeRecordedWorkflow}, these names reach summaries every harness shows
   * (server instructions, search_tools' description), so they are read only from the projected
   * program text, never from a resolved private value.
   */
  recordedWorkflowCommands(artifactDigest: string, context: WorkspaceContext): string[] {
    return this.recordedWorkflowSummary(artifactDigest, context)?.commands ?? [];
  }

  /**
   * The recorded-default inputs of a cached recorded workflow whose recorded value is a date or a
   * time (see {@link isDatedValue}), each with that value as a description may show it (masked
   * where it is private). Such an input is required on this device: rerunning its recorded date
   * would silently answer for the recorded moment. Empty for any other tool.
   */
  recordedWorkflowDatedInputs(
    artifactDigest: string,
    context: WorkspaceContext,
  ): ReadonlyMap<string, string> {
    return this.recordedWorkflowSummary(artifactDigest, context)?.dated ?? new Map();
  }

  /**
   * The recorded value of each recorded-default input that runs it when omitted, for the input
   * schema's `default`: only a single value the plan itself carries, never a private, dated or
   * ambiguous one. Empty for any other tool.
   */
  recordedWorkflowDefaults(
    artifactDigest: string,
    context: WorkspaceContext,
  ): ReadonlyMap<string, string> {
    return this.recordedWorkflowSummary(artifactDigest, context)?.defaults ?? new Map();
  }

  /**
   * Whether the recorded-workflow tool stored under `artifactDigest` can run for the caller
   * `context` describes (see `workflowLocationAvailability`); undefined when the digest is not a
   * readable recorded-workflow artifact.
   */
  recordedWorkflowAvailability(
    artifactDigest: string,
    context: WorkspaceContext,
  ): WorkflowLocationAvailability | undefined {
    const plan = this.recordedPlan(artifactDigest);
    if (plan === undefined) return undefined;
    const owner = this.privateValueOwnerWorkspaceId ?? context.workspaceId;
    return toolRunnableHere(plan, context, {
      resolvePrivate: this.ownedPrivateResolver(plan, owner),
    });
  }

  /** Resolves a private value `plan` declares, only for the workspace that recorded it. */
  private ownedPrivateResolver(
    plan: RecordedWorkflow,
    owner: string | undefined,
  ): (reference: string) => unknown {
    const declared = new Set(plan.privateReferences ?? []);
    const store = this.getPrivateValueStore();
    return (reference) => {
      if (!declared.has(reference)) return undefined;
      const recorded = store.origin?.(reference)?.workspaceId;
      if (!isUsableWorkspaceId(recorded) || !isUsableWorkspaceId(owner) || recorded !== owner) {
        return undefined;
      }
      try {
        return resolvePrivateReference(store, reference);
      } catch {
        return undefined;
      }
    };
  }

  /**
   * What this machine knows about a cached recorded workflow for discovery: how many recorded
   * steps it replays (see `recordedWorkStepCount`), the repositories its located steps run in, and
   * why it cannot run for this caller, if it cannot. Undefined for any other tool.
   */
  recordedWorkflowProfile(
    artifactDigest: string,
    context: WorkspaceContext,
  ): ToolProfile | undefined {
    const plan = this.recordedPlan(artifactDigest);
    if (plan === undefined) return undefined;
    const availability = this.recordedWorkflowAvailability(artifactDigest, context);
    return {
      steps: recordedWorkStepCount(plan),
      locatedRepositories: workflowLocationRepositories(plan),
      ...(availability === undefined || availability.available
        ? {}
        : { unavailableReason: availability.reason }),
    };
  }

  /** The validated recorded plan a cached artifact runs, or undefined for any other artifact. */
  private recordedPlan(artifactDigest: string): RecordedWorkflow | undefined {
    const cached = this.recordedPlans.get(artifactDigest);
    if (cached !== undefined) return cached;
    if (this.cache.getArtifactManifest(artifactDigest)?.runtime?.runtime !== "recorded-workflow") {
      return undefined;
    }
    const artifactDir = this.cache.getArtifactPath(artifactDigest);
    const entrypoint = [BUNDLE_FILE_ENTRYPOINT_TS, BUNDLE_FILE_ENTRYPOINT_JS]
      .map((file) => path.join(artifactDir, file))
      .find(isRegularFileWithoutFollowingSymlink);
    if (entrypoint === undefined) return undefined;
    let plan: RecordedWorkflow | undefined;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(entrypoint, "utf8"));
      if (validateRecordedWorkflow(parsed).valid) plan = parsed as RecordedWorkflow;
    } catch {
      return undefined;
    }
    if (plan !== undefined) this.recordedPlans.set(artifactDigest, plan);
    return plan;
  }

  private recordedWorkflowSummary(
    artifactDigest: string,
    context: WorkspaceContext,
  ): RecordedWorkflowSummary | undefined {
    const owner = this.privateValueOwnerWorkspaceId ?? context.workspaceId;
    const key = `${artifactDigest}\u0000${owner}`;
    const cached = this.recordedWorkflowSummaries.get(key);
    if (cached !== undefined) return cached;
    const plan = this.recordedPlan(artifactDigest);
    if (plan === undefined) return undefined;
    return this.summarizeRecordedPlan(plan, owner, key);
  }

  /**
   * Describes a parsed plan from the values its owner recorded, cached under `key` once a step can
   * be shown. Execution reads the dated inputs of the plan it is about to run through this too.
   */
  private summarizeRecordedPlan(
    plan: RecordedWorkflow,
    owner: string | undefined,
    key: string,
  ): RecordedWorkflowSummary {
    const cached = this.recordedWorkflowSummaries.get(key);
    if (cached !== undefined) return cached;
    const declared = new Set(plan.privateReferences ?? []);
    const store = this.getPrivateValueStore();
    const resolveOwnedValue = (reference: string): unknown => {
      if (!declared.has(reference)) return undefined;
      const recorded = store.origin?.(reference)?.workspaceId;
      if (!isUsableWorkspaceId(recorded) || !isUsableWorkspaceId(owner) || recorded !== owner) {
        return undefined;
      }
      try {
        return resolvePrivateReference(store, reference);
      } catch {
        return undefined;
      }
    };
    const resolveOwned = (reference: string): string | undefined => {
      const value = resolveOwnedValue(reference);
      return typeof value === "string" ? value : undefined;
    };
    // Shown text holds only what the plan carries: each private value it reads is a stable
    // `<private:N>` placeholder, never the value, and only the owning workspace (which alone can
    // run it) sees even that. A resolved value is read only to place holes and recognise dates.
    const placeholders = new Map<string, string>();
    const placeholder = (reference: string): string | undefined => {
      if (resolveOwned(reference) === undefined) return undefined;
      let shown = placeholders.get(reference);
      if (shown === undefined) {
        shown = `<private:${placeholders.size + 1}>`;
        placeholders.set(reference, shown);
      }
      return shown;
    };
    const shownTemplateText = (template: WorkflowValueTemplate): string | undefined => {
      switch (template.type) {
        case "literal":
          return typeof template.value === "string" ? template.value : undefined;
        case "private":
          return placeholder(template.reference);
        case "text": {
          // Composed text reads as its literals with `{input}` where each caller value goes.
          let shown = "";
          for (const part of template.parts) {
            const piece = part.type === "input" ? `{${part.name}}` : shownTemplateText(part);
            if (piece === undefined) return undefined;
            shown += piece;
          }
          return shown;
        }
        default:
          return undefined;
      }
    };
    const shownText = (source: WorkflowValueSource): string | undefined =>
      source.kind === "literal"
        ? typeof source.value === "string"
          ? source.value
          : undefined
        : source.kind === "private"
          ? placeholder(source.reference)
          : source.kind === "template"
            ? shownTemplateText(source.template)
            : undefined;
    /**
     * A legacy program's text resolved on this machine, with where each private value sits in it,
     * so holes are found in the text that runs and the private values masked before it is shown.
     */
    const recordedText = (
      template: WorkflowValueTemplate,
      ranges: PrivateRange[],
      at: number,
    ): string | undefined => {
      switch (template.type) {
        case "literal":
          return typeof template.value === "string" ? template.value : undefined;
        case "private": {
          const value = resolveOwned(template.reference);
          if (value !== undefined) {
            ranges.push({ start: at, end: at + value.length, reference: template.reference });
          }
          return value;
        }
        case "text": {
          let recorded = "";
          for (const part of template.parts) {
            const piece =
              part.type === "input"
                ? `{${part.name}}`
                : recordedText(part, ranges, at + recorded.length);
            if (piece === undefined) return undefined;
            recorded += piece;
          }
          return recorded;
        }
        default:
          return undefined;
      }
    };
    // Command names reach every harness-visible summary, so they come from the projected program:
    // the recording's sanitized source, with any private value left unresolved.
    const projectedTemplateText = (template: WorkflowValueTemplate): string | undefined => {
      switch (template.type) {
        case "literal":
          return typeof template.value === "string" ? template.value : undefined;
        case "private":
          return PROJECTED_PRIVATE_VALUE;
        case "text": {
          let shown = "";
          for (const part of template.parts) {
            const piece = part.type === "input" ? `{${part.name}}` : projectedTemplateText(part);
            if (piece === undefined) return undefined;
            shown += piece;
          }
          return shown;
        }
        case "program":
          return typeof template.sourceReference === "string"
            ? template.source.type === "literal" && typeof template.source.value === "string"
              ? template.source.value
              : undefined
            : projectedTemplateText(template.source);
        default:
          return undefined;
      }
    };
    const projectedText = (source: WorkflowValueSource): string | undefined =>
      source.kind === "literal"
        ? typeof source.value === "string"
          ? source.value
          : undefined
        : source.kind === "template"
          ? projectedTemplateText(source.template)
          : undefined;
    // Defense in depth: a command naming any of the plan's private values is never listed. A
    // projected program's whole original source is not such a value; it is the program itself.
    const programSources = new Set<string>();
    const projectedPrograms: Extract<WorkflowValueTemplate, { type: "program" }>[] = [];
    const collectProgramSources = (template: WorkflowValueTemplate): void => {
      if (template.type === "text") template.parts.forEach(collectProgramSources);
      if (template.type !== "program") return;
      if (typeof template.sourceReference === "string") {
        programSources.add(template.sourceReference);
        projectedPrograms.push(template);
      }
      collectProgramSources(template.source);
    };
    for (const step of plan.steps) {
      for (const argument of step.arguments) {
        if (argument.source.kind === "template") collectProgramSources(argument.source.template);
      }
    }
    const privateValues = [...declared].flatMap((reference) => {
      if (programSources.has(reference)) return [];
      const value = resolveOwned(reference);
      return value === undefined ? [] : [value];
    });
    // Defense in depth for every shown text: each resolved private value, and each original token
    // a projected program's redaction replaced, is scrubbed wherever it would still appear. A
    // projected program's whole original is not scrubbed as one value: unredacted, it is its own
    // shown text.
    const scrubbed = [...declared]
      .filter((reference) => !programSources.has(reference))
      .map(resolveOwnedValue);
    for (const template of projectedPrograms) {
      const original = resolveOwned(template.sourceReference!);
      if (original === undefined || (template.protectedTokens ?? []).length === 0) continue;
      try {
        const tokens = tokenizeProgram(template.language, original);
        for (const index of template.protectedTokens ?? []) {
          scrubbed.push(tokens[index]?.raw, tokens[index]?.value);
        }
      } catch {
        // An original that no longer tokenizes has no protected token to find; it is scrubbed whole.
      }
    }
    const scrubValues = scrubbablePrivateValues(scrubbed);
    const scrub = (text: string): string => scrubPrivateValues(text, scrubValues);
    // Only an input that keeps its recorded token when omitted may be shown with that value: a
    // required input has no value a caller can fall back on, and showing one would claim it does.
    const recordedDefaults = new Set(
      plan.inputs.filter((input) => input.recordedDefault === true).map((input) => input.name),
    );
    /**
     * A program whose tokens are bound to caller inputs: its text with each bound token shown as
     * `{input}`, so a caller sees where a value goes, and the recorded value of each input that runs
     * it when omitted (`value`, to recognise a date; `shown`, masked where it is private).
     *
     * A projected program is read from the sanitized text the plan carries, which tokenizes like its
     * original; the original is resolved only to run. A legacy program is resolved here only to
     * place holes: each private value in it is shown as its placeholder, and a hole inside one is
     * shown as that placeholder too.
     */
    const parameterized = (
      source: WorkflowValueSource,
    ):
      | { text: string; parameters: { name: string; value: string; shown: string }[] }
      | undefined => {
      if (source.kind !== "template" || source.template.type !== "program") return undefined;
      const template = source.template;
      const ranges: PrivateRange[] = [];
      const recorded =
        typeof template.sourceReference === "string"
          ? resolveOwned(template.sourceReference) !== undefined &&
            template.source.type === "literal" &&
            typeof template.source.value === "string"
            ? template.source.value
            : undefined
          : recordedText(template.source, ranges, 0);
      if (recorded === undefined) return undefined;
      const covering = (start: number, end: number): PrivateRange | undefined =>
        ranges.find((range) => range.start < end && start < range.end);
      const masked = ranges.map((range) => ({
        start: range.start,
        end: range.end,
        shown: placeholder(range.reference)!,
      }));
      const show = (replacements: { start: number; end: number; shown: string }[]): string => {
        let text = recorded;
        for (const { start, end, shown } of [...replacements].sort((a, b) => b.start - a.start)) {
          text = `${text.slice(0, start)}${shown}${text.slice(end)}`;
        }
        return text;
      };
      let tokens: ReturnType<typeof tokenizeProgram>;
      try {
        tokens = tokenizeProgram(template.language, recorded);
      } catch {
        return { text: show(masked), parameters: [] };
      }
      const programs = template.holes.some((hole) => hole.embedded !== undefined)
        ? embeddedPrograms(recorded, { prose: true })
        : [];
      const bound = template.holes.flatMap((hole) => {
        if (hole.through !== undefined) {
          // A word list: its whole run of recorded words shows as one `{input}`.
          const first = tokens[hole.token];
          const last = tokens[hole.through];
          if (first === undefined || last === undefined || hole.binding.type !== "input") return [];
          const words = tokens.slice(hole.token, hole.through + 1).map((each) => each.value);
          const run = {
            ...first,
            end: last.end,
            raw: recorded.slice(first.start, last.end),
            value: JSON.stringify(words),
          };
          return [
            {
              token: run,
              name: hole.binding.name,
              span: undefined,
              parameter: recordedDefaults.has(hole.binding.name),
            },
          ];
        }
        const token =
          hole.embedded === undefined
            ? tokens[hole.token]
            : programs.find((program) => program.anchor === hole.token)?.tokens[hole.embedded];
        if (token === undefined || recorded.slice(token.start, token.end) !== token.raw) return [];
        if (
          hole.span !== undefined &&
          (typeof token.value !== "string" || hole.span.end > token.value.length)
        ) {
          return [];
        }
        if (hole.binding.type === "input") {
          return [
            {
              token,
              name: hole.binding.name,
              span: hole.span,
              parameter: recordedDefaults.has(hole.binding.name),
            },
          ];
        }
        // A value an earlier step printed: the recorded one is stale, so name where it comes from.
        if (hole.binding.type === "extract") {
          const producer = hole.binding.stepId;
          const position = plan.steps.findIndex((entry) => entry.id === producer);
          return position < 0
            ? []
            : [
                {
                  token,
                  name: `output of step ${position + 1}`,
                  span: hole.span,
                  parameter: false,
                },
              ];
        }
        // A value a derivation computes from the inputs: shown by its name, never as a parameter.
        const binding = hole.binding;
        if (binding.type === "result") {
          const producer = plan.steps.find((entry) => entry.id === binding.stepId);
          const name = binding.path[0];
          return producer?.origin === "derivation" &&
            typeof name === "string" &&
            binding.path.length === 1
            ? [{ token, name, span: hole.span, parameter: false }]
            : [];
        }
        return [];
      });
      // Span holes show `{input}` inside their token's recorded text: at the same offsets of the
      // raw text when the value appears there verbatim, else inside the decoded value.
      const shownTokens = new Map<(typeof tokens)[number], string>();
      for (const { token, name, span } of bound) {
        // A hole inside a private value shows as that value's placeholder, never its text.
        if (covering(token.start, token.end) !== undefined) continue;
        if (span === undefined) {
          shownTokens.set(token, `{${name}}`);
          continue;
        }
        const value = token.value as string;
        const spans = bound
          .filter((each) => each.token === token && each.span !== undefined)
          .sort((left, right) => right.span!.start - left.span!.start);
        if (shownTokens.has(token)) continue;
        const offset = token.raw.indexOf(value);
        let shown = offset >= 0 ? token.raw : value;
        const base = offset >= 0 ? offset : 0;
        for (const each of spans) {
          shown = `${shown.slice(0, base + each.span!.start)}{${each.name}}${shown.slice(base + each.span!.end)}`;
        }
        shownTokens.set(token, shown);
      }
      return {
        text: show([
          ...masked,
          ...[...shownTokens].map(([token, shown]) => ({
            start: token.start,
            end: token.end,
            shown,
          })),
        ]),
        parameters: bound.flatMap(({ token, name, span, parameter }) => {
          if (!parameter) return [];
          const value =
            span === undefined
              ? String(token.value ?? token.raw)
              : (token.value as string).slice(span.start, span.end);
          const privateValue = covering(token.start, token.end);
          return [
            {
              name,
              value,
              shown: privateValue === undefined ? value : placeholder(privateValue.reference)!,
            },
          ];
        }),
      };
    };
    const steps: RecordedStep[] = [];
    const parameters = new Set<string>();
    // Each recorded-default input's recorded values, a private one as PRIVATE_RECORDED_VALUE.
    const recordedValues = new Map<string, Set<string>>();
    const PRIVATE_RECORDED_VALUE = "\u0000private";
    // Each recorded-default input whose recorded value is a date: it is required, not defaulted.
    const dated = new Map<string, string>();
    const commands: string[] = [];
    for (const [index, step] of plan.steps.entries()) {
      // A derivation is model-written code: describe what it computes, never the code itself.
      if (step.origin === "derivation") {
        const computed = new Set<string>();
        for (const consumer of plan.steps) {
          for (const argument of consumer.arguments) {
            if (
              argument.source.kind !== "template" ||
              argument.source.template.type !== "program"
            ) {
              continue;
            }
            for (const hole of argument.source.template.holes) {
              if (
                hole.binding.type === "result" &&
                hole.binding.stepId === step.id &&
                hole.binding.path.length === 1 &&
                typeof hole.binding.path[0] === "string"
              ) {
                computed.add(`{${hole.binding.path[0]}}`);
              }
            }
          }
        }
        const program = step.callable.program;
        const source = step.arguments.find(
          (argument) => argument.name === program?.argument,
        )?.source;
        const read = new Set<string>();
        if (source?.kind === "template" && source.template.type === "program") {
          for (const hole of source.template.holes) {
            if (hole.binding.type === "input") read.add(`{${hole.binding.name}}`);
          }
        }
        if (computed.size > 0 && read.size > 0) {
          steps.push({
            head: `Step ${index + 1} computes ${[...computed].join(", ")} from ${[...read].join(", ")}`,
          });
        }
        continue;
      }
      const program = step.callable.program;
      if (program === undefined) {
        // A harness tool call (a file write, an edit): the tool and each argument a caller can
        // see — its recorded text, or `{input}` where a caller's value goes — so the block shows
        // every step the tool covers, not only the commands. OMP's `i` is the harness's one-line
        // narration of the call, never its data, so it is not shown.
        const shown = step.arguments.flatMap((argument) => {
          if (
            step.callable.runtime === RESIN_HARNESS_TOOL_RUNTIME &&
            argument.name === OMP_INTENT_ARGUMENT
          ) {
            return [];
          }
          const source = argument.source;
          // A whole argument bound to an input is the bare `input` source; a leaf of a template is
          // the `input` template. Both read as `{input}`.
          const input =
            source.kind === "input"
              ? source.name
              : source.kind === "template" && source.template.type === "input"
                ? source.template.name
                : undefined;
          if (input !== undefined) return [`${argument.name} = {${input}}`];
          const value = shownText(source);
          if (value === undefined) return [];
          const oneLine = scrub(value).replace(/\s+/gu, " ").trim();
          return [
            `${argument.name} = ${oneLine.length > RECORDED_NATIVE_ARGUMENT_CHARS ? `${oneLine.slice(0, RECORDED_NATIVE_ARGUMENT_CHARS)}[...]` : oneLine}`,
          ];
        });
        if (shown.length === 0) continue;
        steps.push({
          head: `Step ${index + 1}${step.optional === undefined ? "" : ` (optional — set ${step.optional.input} to false to skip)`} calls the harness's ${step.callable.name} tool with ${shown.join(", ")}`,
        });
        continue;
      }
      const source = step.arguments.find((argument) => argument.name === program.argument)?.source;
      const bound = source === undefined ? undefined : parameterized(source);
      const programText = source === undefined ? undefined : (bound?.text ?? shownText(source));
      if (programText === undefined || programText.length === 0) continue;
      // Only a literal working directory is shown; a private one stays on this machine.
      const workdirSource = step.arguments.find((argument) => argument.name === "workdir")?.source;
      const workdir =
        workdirSource?.kind === "literal"
          ? typeof workdirSource.value === "string"
            ? workdirSource.value
            : undefined
          : workdirSource?.kind === "template" &&
              workdirSource.template.type === "literal" &&
              typeof workdirSource.template.value === "string"
            ? workdirSource.template.value
            : undefined;
      for (const { name, value, shown } of bound?.parameters ?? []) {
        if (isDatedValue(value)) {
          if (!dated.has(name)) dated.set(name, shown);
        } else {
          parameters.add(`${name} = ${shown}`);
        }
        const values = recordedValues.get(name) ?? new Set<string>();
        values.add(shown === value ? value : PRIVATE_RECORDED_VALUE);
        recordedValues.set(name, values);
      }
      const toggle =
        step.optional === undefined
          ? ""
          : ` (optional — set ${step.optional.input} to false to skip)`;
      if (program.kind === "patch") {
        // An edit reads as the file it edits and the lines it adds, holes shown as `{name}`.
        const lines = programText.split("\n");
        const header = lines.find((line) => line.startsWith("+++ "))?.slice(4);
        const deleted = header === "/dev/null";
        const file = deleted ? lines.find((line) => line.startsWith("--- "))?.slice(4) : header;
        if (file === undefined) {
          // A recorded edit kept wholly private shows only that it runs.
          if (/^<private:\d+>$/u.test(programText)) {
            steps.push({
              head: `Step ${index + 1}${toggle} applies a recorded edit (${programText})`,
            });
          }
          continue;
        }
        const shownFile =
          workdir !== undefined && path.isAbsolute(file) ? path.relative(workdir, file) : file;
        const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ "));
        const preview = added
          .slice(0, RECORDED_PATCH_PREVIEW_LINES)
          .map((line) => line.slice(1))
          .join("\n");
        steps.push({
          head: `Step ${index + 1}${toggle} edits ${shownFile}${deleted ? " (deletes it)" : added.length > 0 ? ", adding:" : ""}`,
          ...(added.length > 0
            ? {
                body: `${preview}${added.length > RECORDED_PATCH_PREVIEW_LINES ? "\n[...]" : ""}`,
              }
            : {}),
        });
        continue;
      }
      if (program.kind === "shell" && source !== undefined) {
        const projected = projectedText(source);
        for (const command of projected === undefined
          ? []
          : programCommands(projected, privateValues)) {
          if (!commands.includes(command)) commands.push(command);
        }
      }
      const note = displayFilterNote(step);
      steps.push({
        head: `Step ${index + 1}${toggle} runs this recorded ${program.kind} program${workdir ? ` in ${workdir}` : ""}:`,
        body: programText,
        ...(note === undefined ? {} : { note }),
      });
    }
    // Step text is scrubbed before any preview is cut, so no part of a private value survives a cut.
    const shownDated = new Map([...dated].map(([name, value]) => [name, scrub(value)]));
    // A schema default only for an input with one recorded value the plan itself carries: never a
    // private, scrubbed, dated or ambiguous one.
    const defaults = new Map<string, string>();
    for (const [name, values] of recordedValues) {
      const [value] = values;
      if (
        values.size === 1 &&
        value !== undefined &&
        value !== PRIVATE_RECORDED_VALUE &&
        !dated.has(name) &&
        scrub(value) === value
      ) {
        defaults.set(name, value);
      }
    }
    if (steps.length === 0) {
      return {
        description: undefined,
        commands,
        dated: shownDated,
        defaults,
        privateValues: scrubValues,
      };
    }
    // An input bound in several places is dated if any of its recorded values is.
    const defaulted = [...parameters]
      .filter((parameter) => !dated.has(parameter.slice(0, parameter.indexOf(" = "))))
      .map(scrub);
    const inputs =
      defaulted.length === 0
        ? ""
        : `\nParameters (each replaces its {name} above; omitted, the recorded value runs): ${defaulted.join("; ")}`;
    const required =
      shownDated.size === 0
        ? ""
        : `\nRequired parameters (each replaces its {name} above; its recorded value was a date, so pass the current one in the same form): ${[...shownDated].map(([name, value]) => `${name} (recorded: ${value})`).join("; ")}`;
    const shownSteps = steps.map((step) => ({
      head: scrub(step.head),
      ...(step.body === undefined ? {} : { body: scrub(step.body) }),
      ...(step.note === undefined ? {} : { note: scrub(step.note) }),
    }));
    const summary: RecordedWorkflowSummary = {
      description: `Recorded on this machine:\n${renderRecordedSteps(shownSteps)}${inputs}${required}`,
      commands,
      dated: shownDated,
      defaults,
      privateValues: scrubValues,
    };
    this.recordedWorkflowSummaries.set(key, summary);
    return summary;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
  }

  private getLoader(): ToolBundleLoader {
    if (typeof this.loaderInstance === "function") {
      return this.loaderInstance();
    }
    if (this.loaderInstance) {
      return this.loaderInstance;
    }
    return new ToolBundleLoader({
      cache: this.cache,
      keyStore: this.keyStore,
      allowDevKeys: this.allowDevKeys,
      development: this.development,
    });
  }

  canExecute(entry: {
    toolId: string;
    version?: string;
    artifactDigest?: string;
  }): boolean {
    if (!entry || !entry.artifactDigest) {
      return false;
    }

    if (!this.cache.isArtifactCached(entry.artifactDigest)) {
      return false;
    }

    const manifest = this.cache.getArtifactManifest(entry.artifactDigest);
    if (!manifest) {
      return false;
    }

    if (entry.toolId && manifest.id !== entry.toolId) {
      return false;
    }

    if (entry.version && manifest.version !== entry.version) {
      return false;
    }

    return true;
  }

  private async verifyArtifactDirectory(
    artifactDir: string,
    entry: LocalArtifactEntry,
    manifest: ToolManifest,
    verifyArchiveDigest = true,
  ): Promise<{ verified: boolean; error?: string }> {
    if (!entry.artifactDigest) {
      return { verified: false, error: "Missing artifact digest" };
    }
    try {
      const root = fs.lstatSync(artifactDir);
      if (root.isSymbolicLink() || !root.isDirectory()) {
        return { verified: false, error: "Artifact root must be a regular directory" };
      }
    } catch {
      return { verified: false, error: "Artifact root is unavailable" };
    }

    // 1. Identity must strictly match
    if (manifest.id !== entry.toolId) {
      return {
        verified: false,
        error: `Tool ID mismatch: expected '${entry.toolId}', got '${manifest.id}'`,
      };
    }
    if (entry.version && manifest.version !== entry.version) {
      return {
        verified: false,
        error: `Version mismatch: expected '${entry.version}', got '${manifest.version}'`,
      };
    }
    if (entry.name && manifest.name !== entry.name) {
      return {
        verified: false,
        error: `Name mismatch: expected '${entry.name}', got '${manifest.name}'`,
      };
    }

    // 2. If signature is required or entry declares signatureIdentity, verify signature.json
    const sigPath = path.join(artifactDir, BUNDLE_FILE_SIGNATURE);
    const hasSig = fs.existsSync(sigPath);
    if (this.requireSignature || Boolean(entry.signatureIdentity?.keyId)) {
      if (!hasSig) {
        return {
          verified: false,
          error: "Bundle signature is required in production but signature.json is missing",
        };
      }
    }

    // 3. Collect regular files, enforce bundle limits, reject symlinks and path traversal
    const maxFiles = DEFAULT_BUNDLE_LIMITS.maxFileCount ?? 1000;
    const maxBytes = DEFAULT_BUNDLE_LIMITS.maxBundleSizeBytes ?? 50 * 1024 * 1024;
    const maxSingleFileBytes = DEFAULT_BUNDLE_LIMITS.maxFileSizeBytes ?? 10 * 1024 * 1024;

    const filesToArchive: Array<{
      path: string;
      content: Buffer;
      executable: boolean;
    }> = [];
    let totalSizeBytes = 0;

    const collectFiles = (currentDir: string, relBase = ""): boolean => {
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return false;
      }

      for (const ent of dirents) {
        const fullPath = path.join(currentDir, ent.name);
        const relPath = relBase ? `${relBase}/${ent.name}` : ent.name;

        try {
          validateBundleEntryPath(relPath);
        } catch {
          return false;
        }

        let lstat: fs.Stats;
        try {
          lstat = fs.lstatSync(fullPath);
        } catch {
          return false;
        }

        if (
          lstat.isSymbolicLink() ||
          lstat.isFIFO() ||
          lstat.isSocket() ||
          lstat.isBlockDevice() ||
          lstat.isCharacterDevice()
        ) {
          return false;
        }

        if (lstat.isDirectory()) {
          if (!collectFiles(fullPath, relPath)) {
            return false;
          }
        } else if (lstat.isFile()) {
          // Exclude only known cache extraction metadata file
          if (relPath === ".extracted") {
            continue;
          }
          if (lstat.size > maxSingleFileBytes) {
            return false;
          }
          totalSizeBytes += lstat.size;
          if (totalSizeBytes > maxBytes) {
            return false;
          }

          let content: Buffer;
          try {
            content = fs.readFileSync(fullPath);
          } catch {
            return false;
          }

          if (content.byteLength !== lstat.size) return false;
          filesToArchive.push({
            path: relPath,
            content,
            executable: (lstat.mode & 0o111) !== 0,
          });
          if (filesToArchive.length > maxFiles) {
            return false;
          }
        } else {
          return false;
        }
      }
      return true;
    };

    if (!collectFiles(artifactDir, "")) {
      return {
        verified: false,
        error: "Artifact directory contains invalid files, symlinks, or exceeds bundle limits",
      };
    }
    if (hasSig) {
      try {
        const sigContent = fs.readFileSync(sigPath, "utf8");
        const sigData = BundleSignatureDataSchema.parse(JSON.parse(sigContent));

        if (entry.signatureIdentity?.keyId && sigData.keyId !== entry.signatureIdentity.keyId) {
          return {
            verified: false,
            error: `Signature keyId mismatch: expected '${entry.signatureIdentity.keyId}', got '${sigData.keyId}'`,
          };
        }

        const loader = this.getLoader();
        const keyStore = this.keyStore ?? loader.keyStore;
        if (keyStore) {
          const unsignedFiles = filesToArchive.filter(
            (file) => file.path !== BUNDLE_FILE_SIGNATURE,
          );
          const { archive: unsignedArchive, fileDigests } = encodeDeterministicTar(unsignedFiles);
          const sigResult = await verifyBundleSignature(sigData, keyStore, {
            allowDevKeys: this.allowDevKeys,
            expectedBundleDigest: createHash("sha256").update(unsignedArchive).digest("hex"),
            expectedFileDigests: fileDigests,
          });
          if (!sigResult.valid) {
            return {
              verified: false,
              error: `Signature verification failed: ${sigResult.error ?? sigResult.reason}`,
            };
          }
        }
      } catch (err) {
        return { verified: false, error: `Signed bundle inspection failed: ${err}` };
      }
    }
    if (!verifyArchiveDigest) return { verified: true };

    // 4. Reconstruct deterministic tar archive and verify against entry.artifactDigest
    try {
      const normEntryDigest = normalizeSha256(entry.artifactDigest, false);
      const { archive } = encodeDeterministicTar(filesToArchive);
      const recomputedDigest = createHash("sha256").update(archive).digest("hex");
      if (recomputedDigest !== normEntryDigest) {
        return {
          verified: false,
          error: `Archive rehash digest '${recomputedDigest}' does not match locked artifactDigest '${normEntryDigest}'`,
        };
      }
    } catch (err) {
      return {
        verified: false,
        error: `Failed to reconstruct deterministic tar archive: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return { verified: true };
  }

  async execute(params: LocalArtifactExecuteParams): Promise<CallToolResult> {
    const { entry, parameters, context } = params;
    this.managedToolAccess?.assertAllowed(entry);
    const artifactDir = this.cache.getArtifactPath(entry.artifactDigest);

    if (!fs.existsSync(artifactDir)) {
      return failedToolResult(
        "runtime_unavailable",
        `Artifact directory does not exist for digest '${entry.artifactDigest}'`,
      );
    }

    // 1. Artifact bytes, never unsigned catalog metadata, govern execution.
    let manifest = this.cache.getArtifactManifest(entry.artifactDigest) ?? undefined;
    if (!manifest) {
      const manifestPath = path.join(artifactDir, BUNDLE_FILE_MANIFEST);
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = fs.readFileSync(manifestPath, "utf8");
          manifest = ToolManifestSchema.parse(JSON.parse(raw));
        } catch (err) {
          return failedToolResult(
            "runtime_unavailable",
            `Failed to parse manifest in artifact '${artifactDir}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    if (!manifest) {
      return failedToolResult(
        "runtime_unavailable",
        `Tool bundle is missing required ${BUNDLE_FILE_MANIFEST}`,
      );
    }

    let catalogDigestMatches = false;
    if (params.manifest) {
      const catalogManifest = ToolManifestSchema.safeParse(params.manifest);
      // Catalog delivery may add provenance metadata or normalize its digest, but
      // it cannot redefine the signed tool's identity, inputs, grants, or limits.
      const executionFields = [
        "id",
        "name",
        "version",
        "parameters",
        "runtime",
        "capabilities",
        "limits",
      ] as const;
      if (
        !catalogManifest.success ||
        executionFields.some(
          (field) => canonicalJson(catalogManifest.data[field]) !== canonicalJson(manifest[field]),
        )
      ) {
        return failedToolResult(
          "runtime_unavailable",
          "Catalog execution manifest does not match the artifact manifest",
        );
      }
      catalogDigestMatches = Boolean(
        entry.manifestDigest && matchesManifestDigest(catalogManifest.data, entry.manifestDigest),
      );
    }

    // 2. A catalog digest may cover different delivery metadata, but only after
    // its execution fields match the artifact. Signature verification below still
    // authenticates all artifact bytes; catalog metadata never replaces those bytes.
    let artifactVerified = false;
    if (
      entry.manifestDigest &&
      !catalogDigestMatches &&
      !matchesManifestDigest(manifest, entry.manifestDigest)
    ) {
      const rehashResult = await this.verifyArtifactDirectory(artifactDir, entry, manifest);
      if (!rehashResult.verified) {
        const computed = computeManifestDigest(manifest);
        return failedToolResult(
          "runtime_unavailable",
          `Manifest digest mismatch: expected ${entry.manifestDigest}, computed ${computed}${rehashResult.error ? `; artifact verification failed: ${rehashResult.error}` : ""}`,
        );
      }
      artifactVerified = true;
    }

    // 3. Extracted metadata integrity check
    const metaPath = path.join(artifactDir, ".extracted");
    if (fs.existsSync(metaPath)) {
      try {
        const metaContent = fs.readFileSync(metaPath, "utf8");
        const meta = JSON.parse(metaContent) as {
          digest?: string;
          verified?: boolean;
        };
        if (meta.digest) {
          const normMeta = normalizeSha256(meta.digest, false);
          const normEntry = normalizeSha256(entry.artifactDigest, false);
          if (normMeta !== normEntry) {
            return failedToolResult(
              "runtime_unavailable",
              `Artifact digest mismatch in extraction metadata: expected ${entry.artifactDigest}, got ${meta.digest}`,
            );
          }
        }
      } catch {
        // Non-fatal if metadata is malformed, other checks verify contents
      }
    }

    // 4. Resolve entrypoint file
    const entrypointTs = path.join(artifactDir, BUNDLE_FILE_ENTRYPOINT_TS);
    const entrypointJs = path.join(artifactDir, BUNDLE_FILE_ENTRYPOINT_JS);
    const entrypointPath = isRegularFileWithoutFollowingSymlink(entrypointTs)
      ? entrypointTs
      : isRegularFileWithoutFollowingSymlink(entrypointJs)
        ? entrypointJs
        : undefined;

    if (!entrypointPath) {
      return failedToolResult(
        "runtime_unavailable",
        `Tool bundle is missing entrypoint file (${BUNDLE_FILE_ENTRYPOINT_TS} or ${BUNDLE_FILE_ENTRYPOINT_JS})`,
      );
    }

    // 5. Bind every signed file and the unsigned archive digest to the trusted signature.
    // A pin requires signatures even for catalog entries without signatureIdentity.
    if (
      !artifactVerified &&
      (this.requireSignature ||
        entry.signatureIdentity?.keyId ||
        fs.existsSync(path.join(artifactDir, BUNDLE_FILE_SIGNATURE)))
    ) {
      const verification = await this.verifyArtifactDirectory(artifactDir, entry, manifest, false);
      if (!verification.verified) {
        return failedToolResult(
          "runtime_unavailable",
          `Bundle signature verification failed: ${verification.error}`,
        );
      }
    }

    // A recorded-workflow artifact is a compiled plan, not a Deno module: the verified
    // entrypoint bytes are the frozen RecordedWorkflow, executed host-side through the
    // same routing the original calls used. The worker sandbox cannot dispatch tool
    // calls, so the plan runs here under the executor's own permissions.
    if (manifest.runtime?.runtime === "recorded-workflow") {
      return await this.executeRecordedWorkflowArtifact(
        entry.artifactDigest,
        entrypointPath,
        parameters,
        context,
        manifest,
        params.signal,
        params.timeoutMs,
      );
    }

    // 6. Set up invocation workspace root and capabilities
    const workspaceRoot = path.resolve(
      context.projectRoot ??
        context.canonicalRoot ??
        (context.lockPath ? path.dirname(path.dirname(context.lockPath)) : undefined) ??
        context.roots?.[0]?.path ??
        this.workspaceRoot,
    );
    const invocationId = `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const manifestCaps = manifest.capabilities ?? {};
    const allowShell = manifestCaps.command?.allowShellExecution === true;

    const commandCap: CommandCapability = {
      allowShellExecution: allowShell,
      allowedCommands: manifestCaps.command?.allowedCommands ?? [],
      allowedBinaries: manifestCaps.command?.allowedBinaries ?? [],
      forbiddenPatterns: manifestCaps.command?.forbiddenPatterns ?? [],
      allowEnvPassthrough: manifestCaps.command?.allowEnvPassthrough ?? [],
    };

    const fsCap: FsCapability = {
      allowWorkspaceRoot: true,
      allowTemp: true,
      readPaths: [workspaceRoot, ...(manifestCaps.fs?.readPaths ?? [])],
      writePaths: [workspaceRoot, ...(manifestCaps.fs?.writePaths ?? [])],
      denyPaths: manifestCaps.fs?.denyPaths ?? [],
      maxFileSizeBytes: manifestCaps.fs?.maxFileSizeBytes ?? 10485760,
    };

    const grant = createInvocationGrant({
      invocationId,
      toolId: manifest.id,
      toolVersion: manifest.version,
      workspaceId: context.workspaceId ?? "default",
      envelopeId: `env_${invocationId}`,
      capabilities: CapabilityManifestSchema.parse({
        ...manifestCaps,
        fs: fsCap,
        command: commandCap,
      }),
    });

    const brokerManager =
      this.brokerManager ??
      new CapabilityBrokerManager({
        requireGrant: true,
        allowUnverifiedBoundaries: true,
        development: true,
      });

    const commandFailures = new CommandFailureDiagnostics(workspaceRoot);
    const brokerHandler = commandFailures.wrap(
      brokerManager.createRequestHandler({
        invocationId,
        grant,
        workspaceRoot,
        // Commands run where the session runs; the grants above stay at the project root.
        workingDirectory: sessionWorkingDirectory(context, workspaceRoot),
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        toolId: manifest.id,
        toolVersion: manifest.version,
      }),
    );

    // 7. Validate the complete reachable artifact graph before constructing a worker.
    const importInspection = inspectArtifactSourceGraph(entrypointPath, artifactDir);
    if (!importInspection.passed) {
      return failedToolResult(
        "runtime_unavailable",
        `Failed to inspect artifact imports: ${importInspection.errors.join("; ")}`,
      );
    }

    // 8. Determine timeout and resource limits from manifest. The manifest limit
    // is authoritative for how long the tool may run; a caller deadline can only
    // shorten it, never silently replace it.
    const manifestTimeoutMs = manifest.limits?.timeoutMs ?? manifest.runtime?.timeoutMs ?? 30000;
    const timeoutMs =
      params.timeoutMs !== undefined
        ? Math.min(params.timeoutMs, manifestTimeoutMs)
        : manifestTimeoutMs;

    const memoryLimitMb = manifest.limits?.maxMemoryBytes
      ? Math.floor(manifest.limits.maxMemoryBytes / (1024 * 1024))
      : (manifest.runtime?.memoryLimitMb ?? 128);

    const maxOutputSizeBytes =
      manifest.limits?.maxOutputBytes ?? manifest.runtime?.maxOutputSizeBytes ?? 1024 * 1024;

    const worker = new WorkerProcess({
      manifest,
      bundleEntrypoint: entrypointPath,
      workspaceRoot,
      capabilities: grant.capabilities,
      timeoutMs,
      memoryLimitMb,
      maxOutputSizeBytes,
      denoExecutable: findDenoBinary({
        denoExecutable: this.denoExecutable,
        resinHome: this.resinHome,
      }),
      brokerHandler,
      importMap: {},
      onProgress: (prog) => {
        params.onProgress?.(prog.percentage, 100);
      },
    });

    if (params.signal?.aborted) {
      return failedToolResult("cancelled", "Tool invocation was cancelled.");
    }

    const onAbort = () => {
      worker.sendCancel(invocationId, "Tool invocation cancelled by caller");
      worker.forceKill();
    };
    params.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      this.managedToolAccess?.assertAllowed(entry);
      const result = await worker.execute(invocationId, parameters, {
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        toolId: manifest.id,
        version: manifest.version,
      });

      if (result.status === "success") {
        const text =
          typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? null);
        const failed = commandFailures.isReportedFailure(result.output);
        const response: CallToolResult = {
          ...(failed ? { isError: true } : {}),
          content: [{ type: "text", text }],
        };
        return failed ? commandFailures.append(response, maxOutputSizeBytes) : response;
      }

      if (params.signal?.aborted) {
        return commandFailures.append(
          failedToolResult(
            "cancelled",
            `Tool invocation was aborted by the caller before it completed (${result.error?.message ?? result.status}); the tool's manifest allows ${manifestTimeoutMs}ms.`,
          ),
          maxOutputSizeBytes,
        );
      }

      return commandFailures.append(
        failedToolResult(
          workerFailureReason(result),
          result.error?.message ?? `Tool execution failed with status: ${result.status}`,
        ),
        maxOutputSizeBytes,
      );
    } catch (err) {
      return commandFailures.append(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        },
        maxOutputSizeBytes,
      );
    } finally {
      params.signal?.removeEventListener("abort", onAbort);
      brokerManager.cleanupInvocation(invocationId);
    }
  }

  /** Where a recorded program step keeps each invocation's full output; none without a home. */
  private invocationOutputRoot(): string | undefined {
    return this.resinHome === undefined
      ? undefined
      : path.join(this.resinHome, "data", "invocation-output");
  }

  /**
   * Executes a verified recorded-workflow artifact. The plan is the frozen
   * RecordedWorkflow the compiler produced; each step dispatches through `stepInvoker`
   * (the same routing the original call used) and private references resolve from the
   * local value store. A plan that needs an adapter or a value this host does not have
   * fails with the actual reason rather than a substituted behavior.
   */
  private async executeRecordedWorkflowArtifact(
    artifactDigest: string,
    entrypointPath: string,
    parameters: JsonRpcParams,
    context: WorkspaceContext,
    manifest: ToolManifest,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<CallToolResult> {
    const stepInvoker = this.stepInvoker;
    let plan: RecordedWorkflow;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(entrypointPath, "utf8"));
      const validation = validateRecordedWorkflow(parsed);
      if (!validation.valid) {
        return failedToolResult(
          "runtime_unavailable",
          `Recorded workflow artifact is not a valid plan: ${validation.errors.join("; ")}`,
        );
      }
      plan = parsed as RecordedWorkflow;
    } catch (err) {
      return failedToolResult(
        "runtime_unavailable",
        `Failed to read recorded workflow artifact: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // A plan input the call left out, which the manifest's schema did not catch: refused before
    // anything runs, with what each input is and the complete call to repeat.
    const planSchema = recordedWorkflowInputSchema(plan);
    const missingInputs = missingRequiredInputs(planSchema, parameters);
    if (missingInputs.length > 0) {
      return missingInputsResult(
        manifest.name ?? plan.workflowId,
        planSchema,
        parameters,
        missingInputs,
      );
    }

    // A recorded date is not a default: omitted, it would rerun the recorded period and answer for
    // that moment as if it were now. Refused before anything runs, naming the input and its form.
    const owner = this.privateValueOwnerWorkspaceId ?? context.workspaceId;
    const { dated } = this.summarizeRecordedPlan(plan, owner, `${artifactDigest}\u0000${owner}`);
    const missing = missingDatedInputs(dated, parameters);
    if (missing.length > 0) {
      return failedToolResult("validation_error", missingDatedInputsMessage(dated, missing));
    }

    // A plan pinned to a place the caller's checkout does not have is not runnable here: refused
    // with the reason, never run in the recorded directory or anywhere else.
    const caller = callerRepository(context);
    const availability = workflowLocationAvailability(
      plan,
      { repository: caller },
      { resolvePrivate: this.ownedPrivateResolver(plan, owner) },
    );
    if (!availability.available) {
      recordDiscoveryFunnelEvent("unavailable_here");
      return failedToolResult(
        "runtime_unavailable",
        `This tool cannot run here: ${availability.reason}.`,
      );
    }

    // A plan that routes a step back through this host needs the dispatcher; a plan that only runs
    // programs of its own does not, so the refusal is per requirement rather than per plan.
    const requiredRuntimes = [...new Set(plan.steps.map((step) => step.callable.runtime))];
    if (!stepInvoker && requiredRuntimes.includes(RESIN_INVOKE_TOOL_RUNTIME)) {
      return failedToolResult(
        "runtime_unavailable",
        "This recorded-workflow tool needs a step dispatcher, which this executor was not given",
      );
    }

    const adapters = new RuntimeAdapterRegistry();
    if (this.recordedWorkflowAdapters) {
      const host: RecordedWorkflowHostContext = {
        manifest,
        workspace: context,
        ...(signal ? { signal } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(this.invocationOutputRoot() === undefined
          ? {}
          : { invocationOutputRoot: this.invocationOutputRoot() }),
        routeToHost: async (request) => {
          if (!stepInvoker) {
            return {
              isError: true,
              content: [{ type: "text", text: "Step dispatcher is not ready" }],
            };
          }
          return await stepInvoker({
            name: request.name,
            ...(request.connection ? { connection: request.connection } : {}),
            parameters: request.parameters,
            context,
            ...(signal ? { signal } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          });
        },
      };
      for (const adapter of this.recordedWorkflowAdapters(host)) {
        if (adapters.has(adapter.runtime)) continue;
        adapters.register(adapter);
      }
    }
    // Running a recorded program is a command execution, so it needs the grant a command needs. A
    // plan the manifest does not authorize is refused here rather than run on the host's account.
    const programRuntimes = requiredRuntimes.filter(
      (runtime) => runtime === RESIN_PROCESS_RUNTIME || runtime === RESIN_PROGRAM_RUNTIME,
    );
    if (programRuntimes.length > 0) {
      const capabilities = CapabilityManifestSchema.safeParse(manifest.capabilities ?? {});
      const granted = capabilities.success
        ? capabilities.data.command?.allowShellExecution === true
        : false;
      if (!granted) {
        return failedToolResult(
          "runtime_unavailable",
          `this recorded workflow runs a program (${programRuntimes.join(", ")}) but its manifest does not grant command execution`,
        );
      }
    }
    if (stepInvoker && !adapters.has(RESIN_INVOKE_TOOL_RUNTIME))
      adapters.register({
        runtime: RESIN_INVOKE_TOOL_RUNTIME,
        call: async (request) => {
          const result = await timeRecordedCall(() =>
            stepInvoker({
              name: request.step.callable.name,
              ...(request.step.callable.connection
                ? { connection: request.step.callable.connection }
                : {}),
              parameters: request.arguments as Record<string, unknown>,
              context,
              ...(signal ? { signal } : {}),
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            }),
          );
          if (result.isError) {
            const text = result.content?.[0]?.type === "text" ? result.content[0].text : undefined;
            throw new Error(text ?? `step '${request.step.id}' failed`);
          }
          return composedResultValue(result);
        },
      });

    const store = this.getPrivateValueStore();
    const artifact: CompiledWorkflowArtifact = {
      plan,
      digest: "",
      name: plan.workflowId,
      inputSchema: {},
      outputContract: { fromStep: plan.steps[plan.steps.length - 1]?.id ?? "", callable: "" },
      requiredRuntimes,
      requiredPrivateReferences: [...(plan.privateReferences ?? [])],
      permissions: [],
    };
    // A private reference is a name, not a capability: the plan may resolve only the references
    // it declares, and only when the value was recorded for the tenant authorized by this
    // invocation. Paired cloud identity is that tenant; WorkspaceContext.workspaceId is the local
    // project UUID and remains the fallback for offline/local-only execution. Both identities must
    // be present, well formed, and equal — a missing or malformed one is unavailable, never global,
    // so an unscoped entry is not claimed by whoever reads it first. A workflow that merely knows
    // another recording's exact reference string is refused here: the recorded origin decides,
    // never the shape of the string.
    const declaredPrivateReferences = new Set(plan.privateReferences ?? []);
    const executingWorkspaceId = this.privateValueOwnerWorkspaceId ?? context.workspaceId;
    const callable = instantiateRecordedWorkflow(artifact, {
      adapters,
      access: { workspaceId: executingWorkspaceId },
      repository: { caller },
      resolvePrivate: (reference: string, access?: { workspaceId?: string }) => {
        if (!declaredPrivateReferences.has(reference)) {
          throw new Error(
            `private reference '${reference}' is not declared by this workflow's recorded plan`,
          );
        }
        const recordedWorkspaceId = store.origin?.(reference)?.workspaceId;
        if (!isUsableWorkspaceId(recordedWorkspaceId)) {
          throw new Error(
            `private reference '${reference}' has no usable recorded workspace origin and cannot be resolved here`,
          );
        }
        const invokingWorkspaceId = access?.workspaceId;
        if (!isUsableWorkspaceId(invokingWorkspaceId)) {
          throw new Error(
            `private reference '${reference}' cannot be resolved without a usable invoking workspace identity`,
          );
        }
        if (invokingWorkspaceId !== recordedWorkspaceId) {
          throw new Error(
            `private reference '${reference}' was recorded for another workspace and cannot be resolved here`,
          );
        }
        return resolvePrivateReference(store, reference) as WorkflowJsonValue;
      },
    });
    try {
      // The invocation's signal (the caller's cancel or the call deadline) reaches every step: the
      // step in flight is stopped, its process tree killed, and no later step runs.
      const execution = await callable.invoke(
        parameters as Record<string, WorkflowJsonValue>,
        signal ? { signal } : {},
      );
      if (execution.status !== "completed") {
        const report =
          (await failedWorkflowReport(plan, execution, this.invocationOutputRoot())) ??
          execution.error ??
          "Recorded workflow execution failed";
        if (signal?.aborted) {
          const reason: unknown = signal.reason;
          const detail =
            reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "";
          const timedOut =
            (reason instanceof Error && reason.name === "TimeoutError") ||
            /\btimed out\b|deadline/i.test(detail);
          return failedToolResult(
            timedOut ? "timeout" : "cancelled",
            `${timedOut ? "Tool invocation timed out" : "Tool invocation was cancelled"}${detail.length > 0 ? ` (${detail})` : ""}: the step in flight was stopped and no later step ran.\n${report}`,
          );
        }
        // Every step that failed ran to completion with a check reporting failure, and no step was
        // skipped or turned off: the tool worked and its result is that failure.
        const failedSteps = execution.steps.filter((outcome) => outcome.status === "failed");
        const checkFailed =
          failedSteps.length > 0 &&
          failedSteps.every((outcome) => outcome.check === true) &&
          !execution.steps.some(
            (outcome) => outcome.status === "skipped" || outcome.status === "omitted",
          );
        return failedToolResult(checkFailed ? "check_failed" : "tool_error", report);
      }
      const result = execution.result ?? null;
      // Several returned outputs are labeled by the plan steps that produced them; the content
      // stays the outputs array, so composition reads the same value.
      const sinks = workflowSinkStepIds(plan);
      const numbers: OutputStepNumbers | undefined =
        sinks.length > 1 && Array.isArray(result) && result.length === sinks.length
          ? {
              steps: sinks.map((stepId) => plan.steps.findIndex((step) => step.id === stepId) + 1),
              total: plan.steps.length,
            }
          : undefined;
      // Several returned outputs with a caller-omitted step among them: label that step skipped.
      const omitted = new Set(
        execution.steps.flatMap((outcome) =>
          outcome.status === "omitted" ? [outcome.stepId] : [],
        ),
      );
      const skipped = new Set(
        sinks.flatMap((stepId, index) => (omitted.has(stepId) ? [index] : [])),
      );
      // A step that reported caller-facing text (a version-2 display-filter step's report) is shown
      // by it; the content keeps the steps' values, which composition reads.
      const completedOf = new Map(
        execution.steps.flatMap((outcome) =>
          outcome.status === "completed" ? [[outcome.stepId, outcome] as const] : [],
        ),
      );
      const lastCompleted = [...execution.steps]
        .reverse()
        .find((outcome) => outcome.status === "completed");
      const display =
        sinks.length > 1 && numbers !== undefined
          ? sinks.some((stepId) => completedOf.get(stepId)?.display !== undefined)
            ? presentStepSections(
                sinks.map((stepId) => {
                  const outcome = completedOf.get(stepId);
                  return outcome === undefined
                    ? null
                    : (outcome.display ?? stepOutputText(outcome));
                }),
                skipped,
                numbers,
              )
            : undefined
          : lastCompleted?.status === "completed"
            ? lastCompleted.display
            : undefined;
      const displayMeta = display === undefined ? {} : { [RESIN_DISPLAY_TEXT_META]: display };
      if (
        omitted.size > 0 &&
        Array.isArray(result) &&
        result.length > 1 &&
        result.every((item) => typeof item === "string" || item === null)
      ) {
        return {
          content: [
            {
              type: "text",
              text: presentStepSections(result as Array<string | null>, skipped, numbers),
            },
          ],
          ...(display === undefined ? {} : { _meta: displayMeta }),
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(numbers === undefined && display === undefined
          ? {}
          : {
              _meta: {
                ...(numbers === undefined
                  ? {}
                  : {
                      [RESIN_OUTPUT_STEPS_META]: {
                        steps: [...numbers.steps],
                        total: numbers.total,
                      },
                    }),
                ...displayMeta,
              },
            }),
      };
    } catch (err) {
      return failedToolResult(
        "tool_error",
        `Recorded workflow execution failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
