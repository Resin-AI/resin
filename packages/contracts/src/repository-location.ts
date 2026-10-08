import { z } from "zod";

/**
 * Event metadata key carrying the repository a recorded call's commands ran in, and where inside
 * it. It rides inside `NormalizedSessionEvent.metadata`, an open record every contracts version
 * accepts, so a cloud that predates the key stores it untouched and ignores it.
 */
export const RESIN_REPOSITORY_METADATA_KEY = "__resinRepositoryV1" as const;

/** Hex characters of a repository id: a full SHA-256. */
export const REPOSITORY_ID_HEX_LENGTH = 64;

/** Longest repository-relative directory the carrier admits. */
export const MAX_REPOSITORY_PATH_LENGTH = 1024;

/**
 * Device capability: this device runs a step's `location` in the caller's checkout and lists a
 * tool whose location it cannot resolve as unavailable. A device without it ignores `location`
 * (the validator is open to unknown step keys) and runs the recorded program as recorded, exactly
 * as before; see {@link WorkflowStepLocation}.
 */
export const REPOSITORY_LOCATION_CAPABILITY = "repository-location-v1" as const;

const REPOSITORY_ID = /^[0-9a-f]{64}$/;

/** Whether `value` is a repository id: lowercase hex SHA-256 of the repository's root commits. */
export function isRepositoryId(value: unknown): value is string {
  return typeof value === "string" && REPOSITORY_ID.test(value);
}

/**
 * Whether `value` is a normalized POSIX directory relative to a repository root: `""` for the root
 * itself, otherwise `/`-separated non-empty segments, none `.` or `..`, no leading or trailing
 * separator, no backslash and no control character.
 */
export function isRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return true;
  if (value.length > MAX_REPOSITORY_PATH_LENGTH) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * Where a recorded call's commands ran, in repository terms only.
 *
 * - `id`: the repository: lowercase hex SHA-256 of its root commit ids (lowercase, sorted, joined
 *   by `\n`). Every clone and worktree of one repository has the same id; different repositories
 *   differ. Nothing about the device or the checkout's location is in it.
 * - `path`: the directory the commands ran in, relative to the checkout's root, POSIX separators,
 *   `""` at the root.
 * - `leadingCd`: the directory is the target of the absolute `cd` the call's program begins with
 *   (`cd /abs/dir && …`, `cd ~/dir; …`), not the call's own working directory. A plan may then
 *   run the program from that directory of the caller's checkout without the `cd`.
 *
 * Only calls whose program runs in a directory carry it (shell commands, program and harness
 * builtins), and only when that directory lies in a git repository with at least one commit.
 */
export const RepositoryLocationMetadataSchema = z
  .object({
    id: z.string().refine(isRepositoryId),
    path: z.string().refine(isRepositoryRelativePath),
    leadingCd: z.literal(true).optional(),
  })
  .strict();

export type RepositoryLocationMetadata = z.infer<typeof RepositoryLocationMetadataSchema>;

/** Reads the carrier, failing closed on anything that is not exactly its frozen shape. */
export function readRepositoryLocationMetadata(
  value: unknown,
): RepositoryLocationMetadata | undefined {
  const parsed = RepositoryLocationMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Where a step runs, relative to the caller's own checkout instead of a recorded absolute path.
 *
 * - `base`: always `"repository"`: the root of the git checkout the invocation's caller works in.
 * - `repository`: the repository id the recording ran in (see {@link RepositoryLocationMetadata}).
 *   The caller's checkout must be of that repository; otherwise the step cannot run here.
 * - `path`: directory under that root, POSIX, `""` for the root. It must exist in the caller's
 *   checkout; otherwise the step cannot run here.
 * - `leadingCd`: the recorded program begins with an absolute `cd` into that directory. The
 *   device drops that `cd` (see {@link splitLeadingCd}) and runs the rest from the directory. The
 *   plan keeps the program byte for byte as recorded, so recording checks and devices without
 *   {@link REPOSITORY_LOCATION_CAPABILITY} are unaffected.
 *
 * A located step runs in `<caller root>/<path>`, overriding the adapter's default directory and
 * any recorded working-directory argument (`cwd`, `workdir`, `workingDirectory`). It is never run
 * anywhere else: a device that cannot resolve the location reports the tool unavailable.
 * Only recorded program steps (shell or program runtimes, not patches, not derivations) may carry
 * one, and every located step of a plan names the same repository.
 */
export type WorkflowStepLocation = {
  base: "repository";
  repository: string;
  path: string;
  leadingCd?: true;
};

/** Why `value` is not a valid {@link WorkflowStepLocation}, or undefined when it is. */
export function workflowStepLocationProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "location must be an object";
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "base" && key !== "repository" && key !== "path" && key !== "leadingCd") {
      return `location has an unknown field ${key}`;
    }
  }
  if (record.base !== "repository") return "location base must be 'repository'";
  if (!isRepositoryId(record.repository)) {
    return "location repository must be a 64-character lowercase hex repository id";
  }
  if (!isRepositoryRelativePath(record.path)) {
    return "location path must be a normalized repository-relative POSIX directory";
  }
  if (Object.hasOwn(record, "leadingCd") && record.leadingCd !== true) {
    return "location leadingCd must be true when present";
  }
  return undefined;
}

/** The distinct repository ids a plan's located steps run in, sorted. */
export function workflowLocationRepositories(plan: {
  steps: ReadonlyArray<{ location?: WorkflowStepLocation }>;
}): string[] {
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (step.location !== undefined) ids.add(step.location.repository);
  }
  return [...ids].sort();
}

/** The target of a program's leading `cd`, as written, and the program after it. */
export interface LeadingCd {
  /**
   * The directory as written, quotes removed. With `home`, the text after a leading `~`, `$HOME`
   * or `${HOME}` (`""` or starting with `/`); otherwise the literal word.
   */
  directory: string;
  home: boolean;
  /** The rest of the program, after the separator and any blanks or line breaks following it. */
  rest: string;
}

/** An unquoted word: no blank, quote, expansion, glob, escape or operator character. */
const PLAIN_WORD = /^[^\s'"`$\\;&|<>(){}*?[\]!#]+/;
const HOME_PREFIX = /^(?:~|\$HOME|\$\{HOME\})(?=[/\s;&"]|$)/;

function leadingCdWord(text: string): { word: string; home: boolean; length: number } | undefined {
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end <= 1) return undefined;
    return { word: text.slice(1, end), home: false, length: end + 1 };
  }
  const quoted = text.startsWith('"');
  const body = quoted ? text.slice(1) : text;
  const home = HOME_PREFIX.exec(body);
  if (home !== null && home[0] === "~" && quoted) return undefined;
  const afterHome = home === null ? body : body.slice(home[0].length);
  let word: string;
  if (quoted) {
    const end = afterHome.indexOf('"');
    if (end < 0) return undefined;
    word = afterHome.slice(0, end);
    if (/["`$\\!]/.test(word)) return undefined;
  } else {
    const plain = PLAIN_WORD.exec(afterHome);
    word = plain === null ? "" : plain[0];
    if (word.includes("~")) return undefined;
  }
  if (home === null && (word.length === 0 || word.startsWith("-"))) return undefined;
  const length = (quoted ? 2 : 0) + (home === null ? 0 : home[0].length) + word.length;
  return { word, home: home !== null, length };
}

/**
 * Splits a POSIX shell program that begins with `cd <one directory>` followed by `&&`, `;` or a
 * line break, and more program after it. The directory must be one word: unquoted without any
 * expansion, glob or escape; single-quoted; or double-quoted without expansion — optionally
 * starting with `~`, `$HOME` or `${HOME}` followed by `/` or the word's end. Anything else
 * (`cd -`, `cd` alone, `cd $DIR`, `cd a b`, a `||` or pipe after it) is undefined, and the program
 * must then run as written.
 */
export function splitLeadingCd(program: string): LeadingCd | undefined {
  const head = /^[ \t]*cd[ \t]+(?:--[ \t]+)?/.exec(program);
  if (head === null) return undefined;
  const afterCd = program.slice(head[0].length);
  const word = leadingCdWord(afterCd);
  if (word === undefined) return undefined;
  const tail = afterCd.slice(word.length);
  const separator = /^[ \t]*(?:&&|;|\r?\n)[ \t\r\n]*/.exec(tail);
  if (separator === null) return undefined;
  if (/^[ \t]*;;/.test(tail)) return undefined;
  const rest = tail.slice(separator[0].length);
  if (rest.trim().length === 0) return undefined;
  if (word.home && word.word.length > 0 && !word.word.startsWith("/")) return undefined;
  return { directory: word.word, home: word.home, rest };
}
