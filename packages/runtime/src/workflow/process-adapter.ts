/**
 * The process runtime family: a callable whose recorded artifact is a process program.
 *
 * The program runs whole. Shell operators, pipes, redirections and exit status are part of what the
 * recorded call did, so the source is handed to the platform shell as one argument and never split,
 * re-quoted or tokenized. A non-zero exit status throws, so the executor records the step as failed
 * rather than passing on a value the program never produced.
 */

import { type ProgramRunnerOptions, runRecordedCall } from "./program-runner.js";
import type { RecordedCallRequest, RuntimeAdapter } from "./recorded-workflow.js";
import { RESIN_PROCESS_RUNTIME } from "./runtime-families.js";

/** Runtime knobs for recorded process programs: time and output bounds applied to every call. */
export type ProcessAdapterOptions = ProgramRunnerOptions;

export function createProcessAdapter(options: ProcessAdapterOptions = {}): RuntimeAdapter {
  return {
    runtime: RESIN_PROCESS_RUNTIME,
    call: (request: RecordedCallRequest) => runRecordedCall(request, options),
  };
}
