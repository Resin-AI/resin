/**
 * The runtime families an ordinary native call can belong to.
 *
 * The observer stamps these names onto `callable.runtime` when it records a native call, and the
 * adapter registry is keyed by them. They are declared here rather than imported from
 * `@resin/observer` so that resolving a recorded family does not depend on the recording
 * application, and the values are pinned by a test that compares them with the observer's
 * vocabulary: a family name that drifts between the two would silently make a recorded call
 * unreachable.
 */

/** A callable the harness reached over a tool protocol: an MCP server, a harness builtin surface. */
export const RESIN_TOOL_PROTOCOL_RUNTIME = "resin-tool-protocol";

/** A callable whose recorded artifact is a process program: a shell command or an exact argv. */
export const RESIN_PROCESS_RUNTIME = "resin-process";

/** A callable whose recorded artifact is a program in a language, run through its interpreter. */
export const RESIN_PROGRAM_RUNTIME = "resin-program";

/**
 * The program kinds a record may name, keyed by `program.kind`. A kind outside this table is not a
 * program this runtime knows how to run, and is refused by name instead of guessed at.
 */
export const RESIN_PROGRAM_LANGUAGES: Record<string, true> = {
  shell: true,
  python: true,
  javascript: true,
  typescript: true,
};
