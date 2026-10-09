/**
 * Check segments: commands of a recorded `&&` chain that only verify the work — run tests, lint,
 * type-check, check formatting, inspect files — and change nothing a later command reads. A plan
 * may make such a segment an optional step (`WorkflowStep.optional`), so a caller who wants only
 * `cargo test` out of `cargo fmt --check && cargo clippy && cargo test` turns the other two off.
 *
 * The classifier is a closed allowlist read from the segment's words (`segmentCommandWords`): an
 * unknown command, a write flag (`--fix`, `--write`, `-u`, ...), a redirection other than a
 * descriptor duplication (`2>&1`), or a pipeline stage that is not a display filter is never a check.
 * Build caches a check writes (`target/`, `node_modules/.cache`) are not state a caller relies on.
 */

import {
  isOptionalSetupSegment,
  isReadOnlyInspectionSegment,
  segmentCommandWords,
} from "./shell-and-chain.js";

/**
 * The device capability for optional check segments: a plan step that is a segment of a recorded
 * chain may be optional (`WorkflowStep.optional`) when {@link optionalSegmentProblem} admits it. A
 * device without it accepts only an optional `mkdir -p` setup segment.
 */
export const OPTIONAL_CHECK_SEGMENTS_CAPABILITY = "optional-check-segments-v1" as const;

/** Flags that make a checker rewrite files or snapshots instead of only reporting. */
const WRITE_FLAGS: ReadonlySet<string> = new Set([
  "--fix",
  "--fix-only",
  "--unsafe-fixes",
  "--write",
  "-w",
  "--apply",
  "--apply-unsafe",
  "--allow-dirty",
  "--allow-staged",
  "--bless",
  "-u",
  "--update",
  "--update-snapshots",
  "--updateSnapshot",
  "--ci=false",
  "--output",
  "-o",
]);

/** Pipeline stages after the command that only shape what is shown (`| tail -20`, `| grep FAIL`). */
const DISPLAY_STAGES: ReadonlySet<string> = new Set([
  "tail",
  "head",
  "grep",
  "egrep",
  "fgrep",
  "wc",
  "sort",
  "uniq",
]);

/** Package-script names a check runs (`pnpm test`, `npm run lint`, `pnpm run check:types`). */
const CHECK_SCRIPT =
  /^(?:test|tests|lint|typecheck|type-check|types|check|coverage)(?::[A-Za-z0-9_.-]+)?$/;

const has = (words: readonly string[], ...flags: string[]): boolean =>
  words.some((word) => flags.includes(word));

/** Whether `words` (command first, `npx`/`exec` wrappers removed) run one known checker. */
function isCheckCommand(words: readonly string[]): boolean {
  const [command, sub, third] = words;
  if (command === undefined) return false;
  const rest = words.slice(1);
  switch (command) {
    case "cargo": {
      // `cargo +nightly clippy`: the toolchain is not the subcommand.
      const args = sub?.startsWith("+") ? words.slice(2) : rest;
      const subcommand = args[0];
      if (subcommand === "fmt") return has(args, "--check");
      if (subcommand === "nextest") return args[1] === "run";
      return (
        subcommand === "test" ||
        subcommand === "check" ||
        subcommand === "clippy" ||
        subcommand === "build" ||
        subcommand === "llvm-cov"
      );
    }
    case "go":
      return sub === "test" || sub === "vet";
    case "gofmt":
      return has(rest, "-l", "-d") && !has(rest, "-w");
    case "golangci-lint":
      return sub === "run";
    case "pytest":
    case "mypy":
    case "pyright":
    case "flake8":
    case "vitest":
    case "jest":
    case "eslint":
    case "tsc":
      return command !== "tsc" || has(rest, "--noEmit", "--noemit");
    case "python":
    case "python3":
      return sub === "-m" && (third === "pytest" || third === "mypy" || third === "unittest");
    case "ruff":
      return sub === "check" || (sub === "format" && has(rest, "--check"));
    case "black":
    case "prettier":
      return has(rest, "--check", "-c", "--list-different", "-l");
    case "biome":
      return sub === "check" || sub === "lint" || sub === "ci";
    case "deno":
      return (
        sub === "test" ||
        sub === "lint" ||
        sub === "check" ||
        (sub === "fmt" && has(rest, "--check"))
      );
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (sub === "test" || sub === "t") return true;
      if (sub === "run") return third !== undefined && CHECK_SCRIPT.test(third);
      if (command === "npm" || sub === undefined) return false;
      // `pnpm lint` runs a script; `pnpm vitest run` an installed checker.
      return CHECK_SCRIPT.test(sub) || isCheckCommand(rest);
    case "make":
      return sub !== undefined && words.length === 2 && CHECK_SCRIPT.test(sub);
    case "git":
      return sub === "diff" || sub === "status" || sub === "log" || sub === "show";
    default:
      return false;
  }
}

/** A runner prefix that runs the checker named after it: `npx eslint`, `pnpm exec tsc`. */
function unwrapped(words: readonly string[]): readonly string[] {
  if (words[0] === "npx" || words[0] === "bunx") return words.slice(1);
  if ((words[0] === "pnpm" || words[0] === "yarn") && (words[1] === "exec" || words[1] === "dlx")) {
    return words.slice(2);
  }
  if ((words[0] === "uv" || words[0] === "poetry") && words[1] === "run") return words.slice(2);
  return words;
}

/** Descriptor duplications, the only redirections a check may carry: they write no file. */
const DUPLICATION = /(^|[ \t])(?:2>&1|1>&2|>&2)(?=[ \t|]|$)/g;

/**
 * Whether one segment of a recorded chain only checks: a read-only inspection (`cat`, `ls`,
 * `grep` of named files), or one known checker run without a write flag, optionally piped through
 * display filters (`cargo clippy 2>&1 | tail -20`). Anything the allowlist does not name is not.
 */
export function isCheckSegment(text: string): boolean {
  if (isReadOnlyInspectionSegment(text)) return true;
  // A descriptor duplication writes no file; any other redirection may.
  const parsed = segmentCommandWords(text.replace(DUPLICATION, "$1"));
  if (parsed === undefined || parsed.redirects) return false;
  const [command, ...stages] = parsed.pipeline;
  if (command === undefined) return false;
  if (!stages.every((stage) => stage[0] !== undefined && DISPLAY_STAGES.has(stage[0]))) {
    return false;
  }
  if (command.some((word) => WRITE_FLAGS.has(word) || word.startsWith("--output="))) return false;
  if (command.some((word) => word.startsWith("--fix") || word.startsWith("--write"))) return false;
  return isCheckCommand(unwrapped(command));
}

/**
 * Why an optional segment step may not be optional, or undefined when it may: its text must be a
 * `mkdir -p` setup (`isOptionalSetupSegment`), or a check ({@link isCheckSegment}) that gates no
 * later segment of its chain doing anything but check — omitting `b` from `a && b && c` runs
 * `a && c`, which is the same work only when `b` changed nothing `c` reads and `c` changes nothing
 * a skipped check would have protected. `later` is the text of each segment step after it.
 */
export function optionalSegmentProblem(text: string, later: readonly string[]): string | undefined {
  if (isOptionalSetupSegment(text)) return undefined;
  if (!isCheckSegment(text)) {
    return "is a segment that is neither a mkdir -p setup nor a check, so it cannot be optional";
  }
  if (!later.every((each) => isCheckSegment(each) || isOptionalSetupSegment(each))) {
    return "is a check segment followed by a segment that is not a check, so it cannot be optional";
  }
  return undefined;
}
