import os from "node:os";
import path from "node:path";
import {
  type NormalizedSessionEvent,
  RESIN_REPOSITORY_METADATA_KEY,
  type RepositoryLocationMetadata,
  isRepositoryRelativePath,
  splitLeadingCd,
} from "@resin/contracts";
import {
  localCallWorkingDirectory,
  localWorkflowEvent,
} from "../normalization/local-workflow-payload.js";
import {
  type RepositoryIdentity,
  repositoryIdentity,
  repositoryRelativeDirectory,
} from "../repository-identity.js";
import {
  RESIN_HARNESS_TOOL_RUNTIME,
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_WORKFLOW_CALL_METADATA_KEY,
  readWorkflowCallCarrier,
} from "./workflow-carrier.js";
import { effectiveWorkingDirectory } from "./working-directory-identity.js";

/** Callables whose work depends on the directory they run in. MCP tool calls are not among them. */
const LOCATED_RUNTIMES: ReadonlySet<string> = new Set([
  RESIN_PROCESS_RUNTIME,
  RESIN_PROGRAM_RUNTIME,
  RESIN_HARNESS_TOOL_RUNTIME,
]);

export interface RepositoryLocationAnnotatorOptions {
  /** Identifies a directory's repository; defaults to {@link repositoryIdentity}. */
  identify?: (directory: string) => RepositoryIdentity | undefined;
  homeDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Attaches `metadata.__resinRepositoryV1 = { id, path, leadingCd? }` to recorded calls: the
 * device-independent id of the git repository the call's commands ran in and the directory
 * relative to its checkout root. That is what lets a plan built from the recording run in another
 * checkout of the same repository — the caller's — instead of the recorded absolute directory.
 *
 * The directory is the call's own working directory (its argument resolved against the session's
 * directory), or the target of an absolute `cd` its program begins with (`leadingCd`). Calls
 * outside a git repository, MCP tool calls and calls with an unknown directory carry nothing.
 */
export class RepositoryLocationAnnotator {
  private readonly identify: (directory: string) => RepositoryIdentity | undefined;
  private readonly homeDir: string;
  private readonly platform: NodeJS.Platform;

  constructor(options: RepositoryLocationAnnotatorOptions = {}) {
    this.identify = options.identify ?? repositoryIdentity;
    this.homeDir = options.homeDir ?? os.homedir();
    this.platform = options.platform ?? process.platform;
  }

  /**
   * Attaches the location `source` ran in to `target`'s metadata (`target` is the event `source`
   * became after the recorders). `source` must be the normalization pipeline's own event, which
   * alone holds the call's unredacted directory and program. Anything already under the key is
   * dropped first: only this device's own computation is attached.
   */
  annotate(
    source: NormalizedSessionEvent,
    target: NormalizedSessionEvent,
    sessionDirectory: string | undefined,
  ): void {
    if (target.metadata !== undefined) delete target.metadata[RESIN_REPOSITORY_METADATA_KEY];
    let location: RepositoryLocationMetadata | undefined;
    try {
      location = this.locate(source, target, sessionDirectory);
    } catch {
      location = undefined;
    }
    if (location === undefined) return;
    target.metadata ??= {};
    target.metadata[RESIN_REPOSITORY_METADATA_KEY] = location;
  }

  private locate(
    source: NormalizedSessionEvent,
    target: NormalizedSessionEvent,
    sessionDirectory: string | undefined,
  ): RepositoryLocationMetadata | undefined {
    if (source.type !== "tool_call" && source.type !== "command_exec") return undefined;
    const carrier = readWorkflowCallCarrier(target.metadata?.[RESIN_WORKFLOW_CALL_METADATA_KEY]);
    if (
      source.type === "tool_call" &&
      (carrier === undefined || !LOCATED_RUNTIMES.has(carrier.runtime))
    ) {
      return undefined;
    }
    const named = localCallWorkingDirectory(source);
    if (named === undefined) return undefined;
    const effective = effectiveWorkingDirectory(named.directory, sessionDirectory, this.homeDir);
    const native = this.platform === "win32" ? "win32" : "posix";
    let directory = effective?.flavor === native ? effective.path : undefined;
    let leadingCd = false;
    const program = this.programText(source, carrier?.program?.argument);
    const cd = program === undefined || native === "win32" ? undefined : splitLeadingCd(program);
    if (cd !== undefined) {
      const target = cd.home ? `${this.homeDir}${cd.directory}` : cd.directory;
      if (path.posix.isAbsolute(target)) {
        directory = path.posix.resolve(target);
        leadingCd = true;
      }
    }
    if (directory === undefined) return undefined;
    const repository = this.identify(directory);
    if (repository === undefined) return undefined;
    const relative = repositoryRelativeDirectory(repository.root, directory);
    if (relative === undefined || !isRepositoryRelativePath(relative)) return undefined;
    return {
      id: repository.id,
      path: relative,
      ...(leadingCd ? { leadingCd: true as const } : {}),
    };
  }

  /** The exact program the call ran, from the retained local original, when it has one. */
  private programText(
    source: NormalizedSessionEvent,
    programArgument: string | undefined,
  ): string | undefined {
    const exact = localWorkflowEvent(source);
    if (exact === undefined) return undefined;
    if (exact.type === "command_exec") {
      const args: unknown = exact.args;
      if (!Array.isArray(args) || args.length === 0) {
        return typeof exact.command === "string" ? exact.command : undefined;
      }
      // `bash -lc '<program>'`: the program is the script the shell was handed.
      const [flag, script] = args;
      return args.length === 2 && (flag === "-c" || flag === "-lc") && typeof script === "string"
        ? script
        : undefined;
    }
    if (exact.type !== "tool_call" || programArgument === undefined) return undefined;
    const parameters: unknown = exact.parameters;
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      return undefined;
    }
    const value: unknown = Reflect.get(parameters, programArgument);
    return typeof value === "string" ? value : undefined;
  }
}
