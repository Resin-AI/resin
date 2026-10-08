/**
 * `resin suggest`: the harness hook entry for command-time suggestions, and the user switch.
 *
 *   resin suggest --harness claude-code   Claude Code PreToolUse hook (payload on stdin)
 *   resin suggest --harness omp           Resin's OMP extension (request on stdin)
 *   resin suggest --disable | --enable    turn suggestions off or back on
 *   resin suggest --status                print whether suggestions are on
 *
 * Packaged launchers run this module directly, without loading the rest of the CLI, so a hook
 * adds tens of milliseconds to a command, not the CLI's start-up time. In hook mode it always
 * exits 0 and prints nothing unless it has a suggestion: Claude Code treats exit code 2 as a
 * block, and a suggestion must never stop or change a command.
 */
import { withResolvers } from "../utils/deferred.js";
import { countSuggestionShown } from "./funnel.js";
import { parseHookInput, renderHookOutput } from "./hook-io.js";
import { isSuggestHarness } from "./render.js";
import {
  type SuggestOptions,
  commandSuggestionsEnabled,
  setCommandSuggestionsEnabled,
  suggestForCommand,
  suggestionsDisabledByEnv,
} from "./suggest.js";

export interface SuggestCliIo {
  readonly stdin?: AsyncIterable<Buffer | string>;
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides for tests. */
  readonly options?: Omit<SuggestOptions, "env">;
  /** How long to wait for the hook payload before giving up silently. */
  readonly stdinTimeoutMs?: number;
}

/** Hook payloads larger than this are ignored. */
const MAX_STDIN_BYTES = 1024 * 1024;
const DEFAULT_STDIN_TIMEOUT_MS = 2_000;

const USAGE = `Usage:
  resin suggest --harness <claude-code|omp>   Read a pending shell command on stdin and print a
                                              learned-tool suggestion (used by harness hooks)
  resin suggest --disable                     Turn command-time suggestions off
  resin suggest --enable                      Turn them back on
  resin suggest --status                      Show whether they are on
`;

async function readStdin(
  stdin: AsyncIterable<Buffer | string>,
  timeoutMs: number,
): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  const read = (async () => {
    for await (const chunk of stdin) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buffer.length;
      if (size > MAX_STDIN_BYTES) return undefined;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  })();
  const { promise: timedOut, resolve } = withResolvers<undefined>();
  const timer = setTimeout(() => resolve(undefined), timeoutMs);
  timer.unref?.();
  try {
    const text = await Promise.race([read, timedOut]);
    // A payload that never ended must not keep the hook process alive.
    if (text === undefined && "destroy" in stdin && typeof stdin.destroy === "function") {
      stdin.destroy();
    }
    return text;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === flag) return argv[index + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

/** Runs `resin suggest` with `argv` (the words after `suggest`); resolves the exit code. */
export async function runSuggestCli(
  argv: readonly string[],
  io: SuggestCliIo = {},
): Promise<number> {
  const env = io.env ?? process.env;
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const options: SuggestOptions = { ...io.options, env };

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(USAGE);
    return 0;
  }
  if (argv.includes("--disable") || argv.includes("--enable")) {
    const enabled = argv.includes("--enable");
    try {
      setCommandSuggestionsEnabled(enabled, options);
    } catch (error) {
      stderr.write(
        `resin suggest: could not update the setting: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
    stdout.write(
      enabled
        ? "Resin command suggestions are on.\n"
        : "Resin command suggestions are off. Run `resin suggest --enable` to turn them back on.\n",
    );
    return 0;
  }
  if (argv.includes("--status")) {
    const on = commandSuggestionsEnabled(options) && !suggestionsDisabledByEnv(env);
    stdout.write(`Resin command suggestions are ${on ? "on" : "off"}.\n`);
    return 0;
  }

  const harness = flagValue(argv, "--harness");
  if (harness === undefined || !isSuggestHarness(harness)) {
    stderr.write(USAGE);
    return 1;
  }
  try {
    const text = await readStdin(
      io.stdin ?? process.stdin,
      io.stdinTimeoutMs ?? DEFAULT_STDIN_TIMEOUT_MS,
    );
    const request = text === undefined ? undefined : parseHookInput(harness, text);
    const suggestion = request === undefined ? undefined : suggestForCommand(request, options);
    if (suggestion !== undefined) {
      stdout.write(renderHookOutput(harness, suggestion.line));
      countSuggestionShown({
        harness,
        ...(options.resinHome === undefined ? {} : { resinHome: options.resinHome }),
      });
    }
  } catch {
    // A hook never fails the command it observes.
  }
  return 0;
}
