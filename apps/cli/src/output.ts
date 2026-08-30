import process from "node:process";

export type VerbosityLevel = "quiet" | "default" | "verbose";

export interface VerbosityResolutionOptions {
  args?: string[];
  flags?: { quiet?: boolean; verbose?: boolean };
  env?: NodeJS.ProcessEnv;
}

export function resolveVerbosity(options: VerbosityResolutionOptions = {}): VerbosityLevel {
  const env = options.env ?? process.env;
  let quiet = options.flags?.quiet;
  let verbose = options.flags?.verbose;

  if (options.args) {
    for (const arg of options.args) {
      if (arg === "--quiet" || arg === "-q") {
        quiet = true;
      } else if (arg === "--verbose" || arg === "-v") {
        verbose = true;
      }
    }
  }

  // Explicit CLI flags take precedence over environment variables
  if (quiet !== undefined || verbose !== undefined) {
    if (quiet) return "quiet";
    if (verbose) return "verbose";
    return "default";
  }

  if (env.RESIN_QUIET === "1" || env.RESIN_QUIET === "true") {
    return "quiet";
  }
  if (env.RESIN_VERBOSE === "1" || env.RESIN_VERBOSE === "true") {
    return "verbose";
  }

  return "default";
}

export interface OutputStreams {
  stdout?: { write(chunk: string): boolean | undefined; isTTY?: boolean };
  stderr?: { write(chunk: string): boolean | undefined };
}

export interface CliOutputOptions {
  verbosity?: VerbosityLevel;
  stdout?: { write(chunk: string): boolean | undefined; isTTY?: boolean };
  stderr?: { write(chunk: string): boolean | undefined };
}

export class CliOutput {
  readonly verbosity: VerbosityLevel;
  readonly stdout: { write(chunk: string): boolean | undefined; isTTY?: boolean };
  readonly stderr: { write(chunk: string): boolean | undefined };

  constructor(options: CliOutputOptions = {}) {
    this.verbosity = options.verbosity ?? "default";
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  get isQuiet(): boolean {
    return this.verbosity === "quiet";
  }

  get isVerbose(): boolean {
    return this.verbosity === "verbose";
  }

  get isDefault(): boolean {
    return this.verbosity === "default";
  }

  /**
   * Diagnostic / progress step output. Only printed in verbose mode.
   */
  step(message: string): void {
    if (this.isVerbose) {
      this.stdout.write(`${message}\n`);
    }
  }

  /**
   * Standard output. Printed in default and verbose mode; suppressed in quiet mode.
   */
  log(message: string): void {
    if (!this.isQuiet) {
      this.stdout.write(`${message}\n`);
    }
  }

  /**
   * Success notification. Printed in default and verbose mode; suppressed in quiet mode.
   */
  success(message: string): void {
    if (!this.isQuiet) {
      this.stdout.write(`${message}\n`);
    }
  }

  /**
   * Raw standard output stream write. Suppressed in quiet mode.
   */
  write(chunk: string): void {
    if (!this.isQuiet) {
      this.stdout.write(chunk);
    }
  }

  /**
   * Always writes to standard output regardless of verbosity (e.g. for JSON or interactive prompts).
   */
  rawStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  /**
   * Actionable error message. Always printed to standard error.
   */
  error(message: string): void {
    this.stderr.write(`${message}\n`);
  }

  /**
   * Raw standard error stream write. Always printed to standard error.
   */
  writeError(chunk: string): void {
    this.stderr.write(chunk);
  }
}
